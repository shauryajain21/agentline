// Claude Code hooks. They never share anything: they only tell agentline which transcript is the
// current session (so share_session knows what to send when the user asks) and mention sessions
// teammates have shared. Silent (no output) when there's nothing to say.
import { getRoom } from './config.mjs';
import { Agentline } from './client.mjs';
import { ago } from './format.mjs';
import { recordSession } from './session.mjs';

const MAX_CONTEXT = 9000; // Claude Code caps additionalContext at 10k chars
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

/** One line per session a teammate shared since we last said so. */
function newShares(t) {
  const me = t.me;
  const msgs = t.store.unread(me, 50).filter((m) => m.kind === 'session' && (!m.to || m.to === me));
  if (!msgs.length) return '';
  for (const m of msgs) t.store.markOne(m.seq);
  return `[agentline] Shared with you: ${msgs.map((m) => `#${m.seq} ${t.store.name(m.from)}'s session "${clip(m.body.transcript?.title, 80)}" (${ago(m.ts)})`).join('; ')}. ` +
    'If it is relevant to what the user is asking, use query_session; otherwise ignore this.';
}

async function handle(t, event, input) {
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return null; // PostToolUse/Stop: no-ops (older installs)
  recordSession(t.store, input);
  await freshen(t);
  const parts = [];
  const pending = t.store.members().filter((m) => m.state === 'pending');
  if (event === 'SessionStart' && pending.length) {
    parts.push(`[agentline] Join requests waiting for approval: ${pending.map((m) => m.name).join(', ')}. Tell the user; approve only if they say so (permissions tool).`);
  }
  const shares = newShares(t);
  if (shares) parts.push(shares);
  return context(event, parts.join('\n\n'));
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
