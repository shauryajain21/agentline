// The MCP server each teammate runs locally (stdio). Works in Claude Code, Cursor, or any MCP client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getRoom } from './config.mjs';
import { Agentline } from './client.mjs';
import { fmtMsg, fmtMember, ago } from './format.mjs';
import { currentSession, parseTranscript, packEntries, unpack } from './session.mjs';
import { VERSION } from './version.mjs';

const LABEL = { user: 'USER', agent: 'AGENT', tool: 'TOOL CALL', result: 'TOOL OUTPUT' };
const sessionCache = new Map();
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instructions(cfg, t) {
  const mates = t.store.members().filter((m) => m.id !== t.me && m.state === 'active').map((m) => m.name);
  return `agentline links you to your teammates' coding agents${mates.length ? ` (${mates.join(', ')})` : ''}. You act for ${cfg.name}. Everything is end-to-end encrypted.

- Share this session ONLY when your human explicitly asks (e.g. "share this session with bob"): call \`share_session\`. Never share on your own initiative, and never share anything else.
- When your human asks about a teammate's work, or their shared session would help answer a question, use \`shared_sessions\` and \`query_session\` (search with \`query\`, then read exact entries with \`entries\`). Cite entry numbers.`;
}

export async function runMcp() {
  const cfg = getRoom();
  const t = new Agentline(cfg, { via: 'agent' });
  const connecting = t.connect();
  const channel = process.env.AGENTLINE_CHANNEL === '1';
  const me = t.me;

  const server = new McpServer(
    { name: 'agentline', version: VERSION },
    { instructions: instructions(cfg, t), capabilities: channel ? { experimental: { 'claude/channel': {} } } : {} },
  );

  // Never block a tool for long on the network: the local replica answers reads instantly.
  async function ready() {
    if (t.state !== 'live') await Promise.race([connecting, sleep(3000)]);
    if (t.state === 'pending') throw new Error(`You (${cfg.name}) are waiting for approval. Ask a room member to approve you (\`agentline approve ${cfg.name}\` or the permissions tool).`);
    if (t.state === 'closed') throw new Error('Access to this room was revoked.');
  }
  const tool = (name, description, inputSchema, handler, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try { await ready(); return await handler(args); }
      catch (e) { return fail(`agentline: ${e.message}`); }
    });
  const render = (m, opts) => fmtMsg(t.store, m, me, opts);
  const offline = () => (t.state === 'live' ? '' : ' (hub unreachable — delivered via HTTP fallback or will retry)');

  tool('share_session',
    'Share THIS Claude Code session (the conversation so far: prompts, replies, tool calls and trimmed outputs) with teammates\' agents so they can query it. Only call when your human explicitly asks you to share. Secrets such as API keys and tokens are redacted. Calling again shares the latest version.',
    {
      to: z.string().optional().describe('Teammate name; omit for everyone in the room'),
      title: z.string().optional().describe('Short title, e.g. "auth refactor"; defaults to the first prompt'),
    },
    async ({ to, title }) => {
      const cur = currentSession(t.store, t.cwd);
      if (!cur) return fail('Could not find this session\'s transcript. Run `agentline install` and restart Claude Code (the hooks tell agentline which session is current).');
      const entries = parseTranscript(cur.path);
      if (!entries.length) return fail('This session has no conversation to share yet.');
      const { gz, count, dropped } = packEntries(entries);
      const name = title || clip(entries.find((e) => e.who === 'user')?.text.replace(/\s+/g, ' ') || 'session', 80);
      const r = await t.send({ to, kind: 'session', text: name, extra: { transcript: { id: cur.id, title: name, count, dropped, gz } } });
      return ok(`shared this session as #${r.seq} → ${to || 'everyone'}: "${name}", ${count} entries${dropped ? ` (oldest ${dropped} left out to fit)` : ''}. API keys and tokens were redacted.${offline()}`);
    });

  tool('shared_sessions',
    'List Claude Code sessions teammates have shared with you (newest first). Query one with query_session.',
    {},
    async () => {
      const rows = latestShares();
      if (!rows.length) return ok('No sessions have been shared yet.');
      return ok(rows.map((m) => `#${m.seq} ${m.from === me ? 'you' : t.store.name(m.from)}${m.to ? ` → ${m.to === me ? 'you' : t.store.name(m.to)}` : ''} · "${m.body.transcript.title}" · ${m.body.transcript.count} entries · ${m.body.session?.label || ''} · ${ago(m.ts)}`).join('\n'));
    }, { readOnlyHint: true });

  tool('query_session',
    'Read a session a teammate shared. With `query`: the most relevant entries. With `entries` ("40-60"): those entries in full. With neither: an outline (every prompt the teammate typed, plus the latest entries). Defaults to the newest shared session.',
    {
      id: z.number().int().optional().describe('Shared session id from shared_sessions, e.g. 12'),
      from: z.string().optional().describe('Teammate name: use their newest shared session'),
      query: z.string().optional().describe('What to look for: topic, file, error, decision…'),
      entries: z.string().regex(/^\d+(-\d+)?$/).optional().describe('Entry range, e.g. "40-60"'),
    },
    async ({ id, from, query, entries: range }) => {
      let m;
      if (id) m = t.store.message(id);
      else {
        const who = from ? t.resolveMember(from) : null;
        m = latestShares().find((x) => (who ? x.from === who : x.from !== me)) || latestShares()[0];
      }
      if (!m || m.kind !== 'session') return fail(id ? `#${id} is not a shared session.` : 'No shared session found. See shared_sessions.');
      const tr = m.body.transcript;
      const list = sessionCache.get(m.seq) || unpack(tr.gz);
      sessionCache.set(m.seq, list);
      const head = `Session #${m.seq} shared by ${m.from === me ? 'you' : t.store.name(m.from)} ${ago(m.ts)}: "${tr.title}" (${m.body.session?.label || 'unknown project'}, ${list.length} entries${tr.dropped ? `; first ${tr.dropped} not included` : ''})`;
      const line = (i, max) => `[${i + 1}] ${LABEL[list[i].who]}: ${clip(list[i].text, max)}`;
      const take = (idx, max, budget) => {
        const out = [];
        for (const i of idx) { const s = line(i, max); if ((budget -= s.length) < 0) { out.push('…(more; narrow the range)'); break; } out.push(s); }
        return out.join('\n');
      };
      if (range) {
        const [a, b = a] = range.split('-').map(Number);
        const idx = []; for (let i = Math.max(1, a); i <= Math.min(b, list.length); i++) idx.push(i - 1);
        return ok(`${head}\n\n${take(idx, 6000, 24000) || 'No entries in that range.'}`);
      }
      if (query) {
        const terms = String(query).toLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((x) => x.length > 1);
        const hits = list.map((e, i) => {
          const hay = e.text.toLowerCase();
          let s = 0; for (const w of terms) if (hay.includes(w)) s += w.length > 3 ? 2 : 1;
          return { i, s: s * (e.who === 'user' || e.who === 'agent' ? 1.5 : 1) };
        }).filter((h) => h.s > 0).sort((x, y) => y.s - x.s).slice(0, 8).map((h) => h.i);
        // Each match plus the entry after it: a prompt's answer, a tool call's output.
        const shown = [...new Set(hits.flatMap((i) => (i + 1 < list.length ? [i, i + 1] : [i])))].sort((x, y) => x - y);
        if (!hits.length) return ok(`${head}\n\nNothing matches "${query}". Try other words, or read the outline (no query).`);
        return ok(`${head}\nTop matches for "${query}" (read around one with entries="a-b"):\n\n${take(shown, 1500, 14000)}`);
      }
      const prompts = list.map((e, i) => i).filter((i) => list[i].who === 'user');
      const tail = list.map((e, i) => i).slice(-12);
      return ok(`${head}\n\nPrompts the teammate typed:\n${take(prompts, 200, 8000)}\n\nLatest entries:\n${take(tail, 500, 8000)}`);
    }, { readOnlyHint: true });

  tool('permissions',
    'Room members, including pending join requests. Approve or remove a member only when your human asks you to.',
    {
      approve: z.string().optional().describe('Approve a pending member by name'),
      revoke: z.string().optional().describe('Remove a member by name'),
    },
    async ({ approve, revoke }) => {
      const notes = [];
      if (approve) { const m = await t.moderate(approve, 'approve'); notes.push(`approved ${m.name}`); }
      if (revoke) { const m = await t.moderate(revoke, 'revoke'); notes.push(`revoked ${m.name}`); }
      return ok([...notes, 'Members:', ...t.store.members().map((m) => '  ' + fmtMember(m, me))].join('\n'));
    });

  /** Newest share per (sender, session) — re-sharing a session replaces the older copy. */
  function latestShares() {
    const seen = new Set();
    return t.store.byKind('session', 0, 500).filter((m) => {
      const k = `${m.from}:${m.body.transcript?.id || m.seq}`;
      if (!m.body.transcript || seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  // Claude Code "channels" (research preview): push teammate messages straight into the session.
  if (channel) {
    t.on('message', (m) => {
      if (m.from === me) return;
      server.server.notification({
        method: 'notifications/claude/channel',
        params: { content: render(m, { inlineBudget: 3000 }), meta: { from: t.store.name(m.from), id: String(m.seq), kind: m.body.kind || 'chat' } },
      }).then(() => t.store.markOne(m.seq)).catch(() => {});
    });
  }

  await server.connect(new StdioServerTransport());
  const shutdown = () => { t.close(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
