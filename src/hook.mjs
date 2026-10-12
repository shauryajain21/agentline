// Claude Code hooks: this is what makes the link *proactive*. Each hook is a short-lived process
// that reads the local replica (kept live by the MCP server) and injects only what's new and
// relevant into the agent's context. Silent (no output) when there's nothing to say.
import { getRoom } from './config.mjs';
import { Agentline } from './client.mjs';
import { fmtMsg, fmtMember, fmtPolicy, ago } from './format.mjs';
import { relPath } from './project.mjs';

const MAX_CONTEXT = 9000; // Claude Code caps additionalContext at 10k chars
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
const SYNC_EVERY_MS = 20_000;

async function stdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

export async function runHook(event) {
  const input = await stdinJson();
  event = event || input.hook_event_name;
  let cfg;
  try { cfg = getRoom(); } catch { return; } // not set up: stay out of the way
  const t = new Agentline(cfg, { via: 'agent', cwd: input.cwd || process.cwd() });
  try {
    const out = await handle(t, event, input);
    if (out) process.stdout.write(JSON.stringify(out));
  } finally {
    t.store.close();
  }
}

async function freshen(t) {
  // If an MCP server holds a live socket, the replica is already current — zero network.
  if (t.isLive()) return;
  const last = t.store.get('lastsync', 0);
  if (Date.now() - last < SYNC_EVERY_MS) return;
  t.store.set('lastsync', Date.now());
  t.httpTimeout = 2500;
  await t.sync().catch(() => {});
}

function context(event, text) {
  if (!text) return null;
  if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT - 40) + '\n…(truncated; use agentline inbox)';
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function unreadBlock(t, budget = 5000) {
  const me = t.me;
  const msgs = t.store.unread(me, 20);
  if (!msgs.length) return '';
  let inline = Math.min(budget, 3000);
  const lines = msgs.map((m) => { const s = fmtMsg(t.store, m, me, { textMax: 700, inlineBudget: inline }); inline -= s.length; return s; });
  t.store.markRead(me, msgs.at(-1).seq);
  const qs = msgs.filter((m) => m.body.kind === 'question' && (!m.to || m.to === me));
  return `[agentline] ${msgs.length} new from teammates' agents:\n${lines.join('\n')}` +
    (qs.length ? `\n→ Answer question(s) ${qs.map((q) => '#' + q.seq).join(', ')} with agentline send(thread=<id>) — from your own context if you can.` : '') +
    `\n(Mention anything relevant to the user's current work in one line; don't derail the task.)`;
}

function openQuestions(t, hours = 48) {
  const me = t.me;
  return t.store.byKind('question', Date.now() - hours * 3600e3, 30)
    .filter((m) => m.from !== me && (!m.to || m.to === me) && !t.store.replies(m.seq).some((r) => r.from === me));
}

async function handle(t, event, input) {
  await freshen(t);
  const me = t.me;
  const mates = t.store.members().filter((m) => m.id !== me && m.state === 'active');
  const policy = t.store.policy();

  switch (event) {
    case 'SessionStart': {
      const p = t.project;
      const briefKey = `lastbrief:${p.id}`;
      const since = t.store.get(briefKey, Date.now() - 72 * 3600e3);
      t.store.set(briefKey, Date.now());
      t.store.prune();
      const parts = [];
      const pending = t.store.members().filter((m) => m.state === 'pending');
      if (!mates.length && !pending.length) return null;
      parts.push(`[agentline] You're linked with ${mates.map((m) => m.name).join(', ') || 'nobody yet'} (room permissions: ${fmtPolicy(policy)}).`);
      if (mates.length) parts.push(mates.map((m) => '  ' + fmtMember(m, me)).join('\n'));
      if (pending.length) parts.push(`Join requests waiting for approval: ${pending.map((m) => m.name).join(', ')} — tell the user; approve only if they say so (agentline permissions).`);

      const logs = t.store.byKind('worklog', since, 50).filter((m) => m.from !== me);
      const here = logs.filter((m) => m.project === p.id).slice(0, 5);
      const elsewhere = logs.filter((m) => m.project !== p.id).slice(0, 3);
      if (here.length) parts.push(`Teammate work on ${p.name} since you were last here — mention it if relevant to what the user starts on (e.g. offer to review):\n` +
        here.map((m) => fmtMsg(t.store, m, me, { textMax: 400 })).join('\n'));
      if (elsewhere.length) parts.push('Elsewhere: ' + elsewhere.map((m) => `#${m.seq} ${t.store.name(m.from)} on ${m.body.worklog?.project?.split('/').pop()}: ${clip(m.body.worklog?.summary, 120)}`).join(' | '));
      const unread = unreadBlock(t, 4000);
      if (unread) parts.push(unread);
      const open = openQuestions(t).filter((q) => q.read);
      if (open.length) parts.push(`Still unanswered: ${open.map((q) => `#${q.seq} from ${t.store.name(q.from)}: ${clip(q.body.text, 160)}`).join(' | ')}`);
      const mem = t.store.memories().length;
      if (mem) parts.push(`Shared team memory has ${mem} entries (agentline recall / context).`);
      return context('SessionStart', parts.join('\n\n'));
    }

    case 'UserPromptSubmit':
      return context('UserPromptSubmit', unreadBlock(t));

    case 'PostToolUse': {
      const parts = [];
      const tool = input.tool_name || '';
      const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (file && (EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool))) {
        const p = t.project;
        const rel = relPath(p, file);
        t.store.touch(input.session_id || 'unknown', p.id, rel, tool, EDIT_TOOLS.has(tool));
        if (policy.overlap && mates.length) {
          const hint = overlap(t, p, rel, input.session_id);
          if (hint) parts.push(hint);
        }
      }
      if (!tool.startsWith('mcp__agentline__')) {
        const unread = unreadBlock(t, 3000);
        if (unread) parts.push(unread);
      }
      return context('PostToolUse', parts.join('\n\n'));
    }

    case 'Stop': {
      if (input.stop_hook_active || !mates.length) return null;
      const session = input.session_id || 'unknown';
      // 1) A teammate's agent asked us something and we haven't answered: don't go idle on them.
      const nudged = new Set(t.store.get(`stopq:${session}`, []));
      const open = openQuestions(t, 12).filter((q) => !nudged.has(q.seq));
      if (open.length) {
        t.store.set(`stopq:${session}`, [...nudged, ...open.map((q) => q.seq)].slice(-100));
        t.store.markRead(me, Math.max(...open.map((q) => q.seq)));
        return { decision: 'block', reason: `[agentline] Before you stop: unanswered question(s) from teammates' agents:\n` +
          open.map((q) => fmtMsg(t.store, q, me, { textMax: 600 })).join('\n') +
          `\nAnswer each with agentline send(thread=<id>) using what you know from this session (say so if you don't know). Ask your human only if it truly needs their call.` };
      }
      // 2) Meaningful edits since the last worklog: offer (ask) or post (auto) a worklog.
      if (!policy.worklogs) return null;
      const p = t.project;
      const lastLog = t.store.get(`lastlog:${p.id}`, 0);
      const lastNudge = t.store.get(`stoplog:${session}`, 0);
      const files = t.store.projectEdits(p.id, Math.max(lastLog, lastNudge));
      const edits = files.reduce((n, f) => n + f.edits, 0);
      if (edits < 3) return null;
      t.store.set(`stoplog:${session}`, Date.now());
      const names = mates.map((m) => m.name).join(' & ');
      const list = files.slice(0, 8).map((f) => f.path).join(', ');
      return { decision: 'block', reason: policy.autonomy === 'auto'
        ? `[agentline] You changed ${files.length} file(s) in ${p.name} (${list}). Post a concise worklog for ${names} with agentline log (summary, next), then tell the user in one line that you did.`
        : `[agentline] You changed ${files.length} file(s) in ${p.name} (${list}). End with ONE short line offering to share a worklog with ${names} (e.g. "Want me to send ${names} a quick summary of this?"). Do not send it unless the user says yes.` };
    }
  }
  return null;
}

/** "<teammate> touched this file 3h ago" — once per file per session. */
function overlap(t, p, rel, session) {
  const key = `ovl:${session}`;
  const seen = new Set(t.store.get(key, []));
  if (seen.has(rel)) return null;
  seen.add(rel);
  t.store.set(key, [...seen].slice(-500));
  const hits = t.store.byKind('worklog', Date.now() - 7 * 864e5, 200)
    .concat(t.store.byKind('share', Date.now() - 7 * 864e5, 100))
    .filter((m) => m.from !== t.me && m.project === p.id &&
      ((m.body.worklog?.files || []).includes(rel) || (m.body.attachments || []).some((a) => a.path === rel)));
  if (!hits.length) {
    const st = t.store.members().find((m) => m.id !== t.me && m.online && m.status?.project === p.id && m.status?.text?.includes(rel.split('/').pop()));
    return st ? `[agentline] Heads-up: ${st.name} is working on ${rel} right now ("${clip(st.status.text, 160)}"). Consider coordinating vian agentline send.` : null;
  }
  const h = hits.sort((a, b) => b.seq - a.seq)[0];
  return `[agentline] Heads-up: ${t.store.name(h.from)} worked on ${rel} ${ago(h.ts)} (#${h.seq}): ${clip(h.body.worklog?.summary || h.body.text, 300)}` +
    `${h.body.worklog?.next ? ` — next: ${clip(h.body.worklog.next, 160)}` : ''}. Tell the user if it matters for this change; agentline read(${h.seq}) for details.`;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
