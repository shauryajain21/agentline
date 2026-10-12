// Session sharing: turn a Claude Code or Cursor transcript (JSONL) into compact, redacted entries,
// pack them small enough for one hub message, and let a teammate's agent search/read them.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAX_GZ = 1_000_000;        // packed size budget; the hub caps a sealed message at 2MB
const RESULT_MAX = [2000, 600, 200]; // tool output kept per entry, tightened until the session fits

/** Hooks call this with Claude Code's hook input so the MCP server knows which transcript is "this session". */
export function recordSession(store, input) {
  if (!input.transcript_path) return;
  const cur = { path: input.transcript_path, id: input.session_id || null, cwd: input.cwd || null, ts: Date.now() };
  store.set('cur', cur);
  if (cur.cwd) store.set(`cur:${cur.cwd}`, cur);
}

/** The session the user is talking to right now: latest prompt in this folder, else latest anywhere. */
export function currentSession(store, cwd) {
  const here = store.get(`cur:${cwd}`), any = store.get('cur');
  return here && (!any || any.ts - here.ts < 10 * 60e3) ? here : any;
}

/**
 * Cursor writes each agent conversation to ~/.cursor/projects/<folder-slug>/agent-transcripts/<id>/<id>.jsonl.
 * "This session" = the most recently written one, preferring this folder's. The user's "share this
 * session" prompt has just been appended to it, so it is the newest file.
 */
export function cursorSession(cwd) {
  const root = process.env.CURSOR_PROJECTS_DIR || join(homedir(), '.cursor', 'projects');
  if (!existsSync(root)) return null;
  const newest = (dirs) => {
    let best = null;
    for (const d of dirs) {
      const base = join(root, d, 'agent-transcripts');
      let ids; try { ids = readdirSync(base); } catch { continue; }
      for (const id of ids) {
        const path = join(base, id, `${id}.jsonl`);
        let st; try { st = statSync(path); } catch { continue; }
        if (!best || st.mtimeMs > best.ts) best = { path, id, cwd, ts: st.mtimeMs, source: 'cursor' };
      }
    }
    return best;
  };
  const slug = String(cwd || '').replace(/^\/+/, '').replace(/[^A-Za-z0-9-]/g, '-');
  return (slug && newest([slug])) || newest(readdirSync(root));
}

const SECRETS = [
  /\b(sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,})/g,          // OpenAI / Anthropic
  /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,  // GitHub
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,                             // Slack
  /\b(AKIA[0-9A-Z]{16})/g,                                         // AWS access key id
  /\b(AIza[0-9A-Za-z_-]{35})/g,                                    // Google
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, // JWTs
  /\b(agentline1\.[A-Za-z0-9_-]{20,})/g,                           // our own invites (contain the room key)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
// `API_KEY=...`, `"token": "..."`, `Authorization: Bearer ...` — keep the name, drop the value.
const ASSIGNED = /((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^\s"',;]{12,})/gi;

export function redact(text) {
  let out = String(text);
  for (const re of SECRETS) out = out.replace(re, '[REDACTED]');
  return out.replace(ASSIGNED, (m, name, value) => (value === '[REDACTED]' ? m : `${name}[REDACTED]`));
}

const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
// Cursor wraps the typed prompt: <timestamp>…</timestamp><user_query>…</user_query> (+ other context tags).
const userText = (s) => { const q = s.match(/<user_query>([\s\S]*?)<\/user_query>/); return q ? q[1].trim() : stripReminders(s); };
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : '')).join('\n') : '');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s);

function toolCall(b) {
  const i = b.input || {};
  const main = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? i.description;
  return `${b.name}: ${main !== undefined ? String(main) : JSON.stringify(i)}`;
}

/** Claude Code or Cursor transcript JSONL -> [{ who: 'user'|'agent'|'tool'|'result', text }] (main thread only, no thinking). */
export function parseTranscript(path) {
  const entries = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || e.isMeta || !e.message) continue;
    const c = e.message.content;
    const type = e.type || e.role; // Claude Code: type, Cursor: role
    if (type === 'user') {
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
        for (const b of c) if (b.type === 'tool_result') entries.push({ who: 'result', text: flat(b.content) });
      } else {
        const text = userText(flat(c));
        if (text && !text.startsWith('<command-') && !text.startsWith('<local-command')) entries.push({ who: 'user', text });
      }
    } else if (type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) entries.push({ who: 'agent', text: b.text.trim() });
        else if (b.type === 'tool_use') entries.push({ who: 'tool', text: toolCall(b) });
      }
    }
  }
  return entries;
}

/** Redact + shrink until the gzip fits. Returns { gz, count, dropped }. Oldest entries go last-resort. */
export function packEntries(entries) {
  const base = entries.map((e) => ({ ...e, text: redact(e.text) }));
  for (const max of RESULT_MAX) {
    const shrunk = base.map((e) => (e.who === 'result' || e.who === 'tool' ? { ...e, text: clip(e.text, max) } : e));
    let dropped = 0;
    let list = shrunk;
    while (list.length) {
      const gz = gzipSync(JSON.stringify(list), { level: 9 });
      if (gz.length <= MAX_GZ) return { gz: gz.toString('base64'), count: list.length, dropped };
      if (max !== RESULT_MAX.at(-1)) break; // tighten tool output before dropping history
      const cut = Math.max(1, Math.ceil(list.length * 0.1));
      list = list.slice(cut); dropped += cut;
    }
  }
  throw new Error('session is too large to share');
}

export const unpack = (gz) => JSON.parse(gunzipSync(Buffer.from(gz, 'base64')).toString('utf8'));
