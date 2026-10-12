#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { b64u, deriveKeys, verifierFor, encodeInvite, decodeInvite, randomId } from './crypto.mjs';
import { getRoom, putRoom, loadConfig, saveConfig } from './config.mjs';
import { VERSION } from './version.mjs';

const CLI = fileURLToPath(import.meta.url);
const HELP = `agentline ${VERSION} — a private link between teammates' coding agents

Setup
  agentline hub [--port 8787] [--host 0.0.0.0] [--db agentline-hub.db]   run the relay (one per team)
  agentline init --hub <url> --name <you> [--alias <room>] [--open]     create a room, print an invite
  agentline join <invite> --name <you>                                  request to join a room
  agentline approve <name> | agentline revoke <name>                       shared permission: who's in
  agentline install [--channel] [--cursor] [--dry-run]                  wire into Claude Code (MCP + hooks)
  agentline uninstall                                                   remove hooks + MCP entry

Use
  agentline chat                     live terminal chat with your teammates and their agents
  agentline ui [--port 4545]         web chat + team/memory/permissions dashboard
  agentline send <text> [--to name]  send as a human
  agentline team                     who's online, what they're working on
  agentline tail [-n 20]             recent messages
  agentline invite | rooms | use <room> | doctor

Internal
  agentline mcp                      stdio MCP server (what Claude Code / Cursor launch)
  agentline hook <Event>             Claude Code hook handler`;

const die = (msg) => { console.error(`agentline: ${msg}`); process.exit(1); };

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    .catch((e) => die(`cannot reach hub at ${url}: ${e.cause?.code || e.message}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `hub returned ${res.status}`);
  return data;
}

async function client(opts = {}) {
  const { Agentline } = await import('./client.mjs');
  return new Agentline(getRoom(opts.room), { via: 'human' });
}

const commands = {
  async hub(args) {
    const { values } = parseArgs({ args, options: { port: { type: 'string', default: process.env.PORT || '8787' }, host: { type: 'string', default: '0.0.0.0' }, db: { type: 'string', default: process.env.AGENTLINE_HUB_DB || 'agentline-hub.db' } } });
    const { startHub } = await import('./hub.mjs');
    const h = await startHub({ port: Number(values.port), host: values.host, dbPath: values.db });
    console.log(`agentline hub ${VERSION} listening on ${values.host}:${h.port} (db: ${values.db})`);
    console.log('Expose it to your teammate with e.g. `ngrok http ' + h.port + '`, Tailscale, or deploy the Dockerfile.');
  },

  async init(args) {
    const { values } = parseArgs({ args, options: { hub: { type: 'string' }, name: { type: 'string' }, alias: { type: 'string' }, open: { type: 'boolean', default: false } } });
    if (!values.hub || !values.name) die('usage: agentline init --hub <url> --name <you> [--alias <room>] [--open]');
    const hub = values.hub.replace(/\/$/, '');
    const room = randomId(9), secret = b64u(randomBytes(32));
    const keys = deriveKeys(secret, room);
    const r = await post(`${hub}/v1/rooms`, { room, verifier: verifierFor(keys.auth), name: values.name, requireApproval: !values.open });
    putRoom({ hub, room, secret, member: r.member, token: r.token, name: values.name, alias: values.alias || null });
    const invite = encodeInvite({ hub, room, secret });
    console.log(`Created room ${values.alias || room}. You are ${values.name}.\n`);
    console.log(`Send this invite to your teammate over a private channel (it contains the room key):\n\n  ${invite}\n`);
    console.log(`They run:  agentline join ${invite.slice(0, 18)}… --name <their-name>`);
    console.log(values.open ? 'Room is open: anyone with the invite gets in.' : 'Then you approve them:  agentline approve <their-name>   (or just ask your agent)');
    console.log('\nNext: agentline install   (connects Claude Code: MCP server + proactive hooks)');
  },

  async join(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' }, alias: { type: 'string' } } });
    if (!positionals[0] || !values.name) die('usage: agentline join <invite> --name <you>');
    const { hub, room, secret } = decodeInvite(positionals[0]);
    const keys = deriveKeys(secret, room);
    const r = await post(`${hub}/v1/rooms/${room}/join`, { auth: b64u(keys.auth), name: values.name });
    putRoom({ hub, room, secret, member: r.member, token: r.token, name: values.name, alias: values.alias || null });
    console.log(r.state === 'active' ? `Joined ${room} as ${values.name}.` : `Join requested as ${values.name}. A room member must approve you (they run: agentline approve ${values.name}).`);
    console.log('Next: agentline install');
  },

  async approve(args) { await moderate(args, 'approve'); },
  async revoke(args) { await moderate(args, 'revoke'); },

  async team() {
    const t = await client();
    const s = await t.sync();
    const { fmtMember, fmtPolicy } = await import('./format.mjs');
    if (s.pending) { console.log('You are waiting for approval.'); return; }
    console.log(t.store.members().map((m) => fmtMember(m, t.me)).join('\n'));
    console.log(`\nPermissions: ${fmtPolicy(t.store.policy())}`);
    const p = t.store.policyDoc().proposal;
    if (p) console.log(`Open proposal by ${t.store.name(p.by)}: ${JSON.stringify(p.settings)}`);
  },

  async send(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { to: { type: 'string' } } });
    if (!positionals.length) die('usage: agentline send <text> [--to name]');
    const t = await client();
    await t.sync();
    const r = await t.send({ text: positionals.join(' '), to: values.to });
    console.log(`sent #${r.seq}`);
  },

  async tail(args) {
    const { values } = parseArgs({ args, options: { n: { type: 'string', short: 'n', default: '20' } } });
    const t = await client();
    await t.sync().catch(() => {});
    const { fmtMsg } = await import('./format.mjs');
    for (const m of t.store.recent(Number(values.n))) console.log(fmtMsg(t.store, m, t.me, { textMax: 400 }) + '\n');
  },

  async chat() { await runChat(await client()); },

  async ui(args) {
    const { values } = parseArgs({ args, options: { port: { type: 'string', default: '4545' }, 'no-open': { type: 'boolean', default: false } } });
    const { runUi } = await import('./ui.mjs');
    const url = await runUi(await client(), Number(values.port));
    console.log(`agentline ui: ${url}`);
    if (!values['no-open'] && process.platform === 'darwin') execFileSync('open', [url]);
  },

  async invite() {
    const r = getRoom();
    console.log(encodeInvite(r));
  },

  async rooms() {
    const cfg = loadConfig();
    for (const r of Object.values(cfg.rooms)) console.log(`${r.room === cfg.default ? '*' : ' '} ${r.alias || r.room}  (${r.name} @ ${r.hub})`);
  },

  async use(args) {
    const r = getRoom(args[0]);
    const cfg = loadConfig(); cfg.default = r.room; saveConfig(cfg);
    console.log(`default room: ${r.alias || r.room}`);
  },

  async mcp() { const { runMcp } = await import('./mcp.mjs'); await runMcp(); },
  async hook(args) { const { runHook } = await import('./hook.mjs'); await runHook(args[0]); },

  async install(args) {
    const { values } = parseArgs({ args, options: { channel: { type: 'boolean', default: false }, cursor: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, settings: { type: 'string' } } });
    getRoom(); // must be in a room first
    const dry = values['dry-run'];
    const node = process.execPath;
    const settingsPath = values.settings || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    settings.hooks = stripHooks(settings.hooks || {});
    const hook = (ev, timeout, matcher) => ({ ...(matcher && { matcher }), hooks: [{ type: 'command', command: `"${node}" "${CLI}" hook ${ev} # agentline-hook`, timeout }] });
    for (const [ev, timeout, matcher] of [['SessionStart', 10], ['UserPromptSubmit', 5]]) {
      (settings.hooks[ev] ||= []).push(hook(ev, timeout, matcher));
    }
    const mcpArgs = ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', ...(values.channel ? ['--env', 'AGENTLINE_CHANNEL=1'] : []), 'agentline', '--', node, CLI, 'mcp'];
    if (dry) {
      console.log(`Would write hooks to ${settingsPath}:\n${JSON.stringify(settings.hooks, null, 2)}\n\nWould run: claude ${mcpArgs.join(' ')}`);
      return;
    }
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.agentline-backup');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`✓ hooks added to ${settingsPath} (backup: settings.json.agentline-backup)`);
    try {
      try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'agentline'], { stdio: 'ignore' }); } catch { /* not there yet */ }
      execFileSync('claude', mcpArgs, { stdio: 'inherit' });
      console.log('✓ MCP server "agentline" registered with Claude Code (user scope)');
    } catch {
      console.log(`! Could not run the claude CLI. Register the MCP server yourself:\n  claude ${mcpArgs.join(' ')}`);
    }
    if (values.cursor) {
      const p = join(homedir(), '.cursor', 'mcp.json');
      const c = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
      c.mcpServers = { ...(c.mcpServers || {}), agentline: { command: node, args: [CLI, 'mcp'] } };
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
      console.log(`✓ Cursor MCP config updated (${p}). Cursor can share its current conversation and query shared sessions.`);
    }
    if (values.channel) console.log('Live push: start Claude Code with  claude --dangerously-load-development-channels server:agentline');
    console.log('Restart Claude Code sessions to pick it up.');
  },

  async uninstall(args) {
    const { values } = parseArgs({ args, options: { settings: { type: 'string' } } });
    const settingsPath = values.settings || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      s.hooks = stripHooks(s.hooks || {});
      writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
      console.log('✓ hooks removed');
    }
    try { execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'agentline'], { stdio: 'inherit' }); } catch { /* ignore */ }
  },

  async doctor() {
    const r = getRoom();
    console.log(`room ${r.alias || r.room} as ${r.name} via ${r.hub}`);
    const h = await fetch(r.hub + '/health', { signal: AbortSignal.timeout(5000) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    console.log(h.ok ? `✓ hub reachable (v${h.version})` : `✗ hub unreachable: ${h.error}`);
    const t = await client();
    try { const s = await t.sync(); console.log(s.pending ? '… awaiting approval' : `✓ authenticated; ${t.store.members().length} members`); }
    catch (e) { console.log(`✗ sync failed: ${e.message}`); }
    console.log(t.isLive() ? '✓ an MCP server is live (hooks read locally)' : '· no live MCP server right now (hooks fall back to HTTP)');
  },

  help() { console.log(HELP); },
};

function stripHooks(hooks) {
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = hooks[ev].filter((g) => !(g.hooks || []).some((h) => String(h.command || '').includes('# agentline-hook')));
    if (!hooks[ev].length) delete hooks[ev];
  }
  return hooks;
}

async function moderate(args, action) {
  if (!args[0]) die(`usage: agentline ${action} <name>`);
  const t = await client();
  await t.sync();
  const m = await t.moderate(args[0], action).catch((e) => die(e.message));
  console.log(`${action === 'approve' ? 'approved' : 'revoked'} ${m.name}`);
}

async function runChat(t) {
  const { fmtMsg, fmtMember } = await import('./format.mjs');
  const c = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', reset: '\x1b[0m' };
  let to = null;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  const setPrompt = () => { rl.setPrompt(`${c.cyan}${to ? '@' + t.store.name(to) : 'all'}>${c.reset} `); rl.prompt(true); };
  const print = (s) => { process.stdout.write('\r\x1b[K' + s + '\n'); setPrompt(); };
  const show = (m) => print(`${m.from === t.me ? c.dim : c.bold}${fmtMsg(t.store, m, t.me, { textMax: 2000, inlineBudget: 1500 })}${c.reset}`);

  t.on('message', show);
  t.on('presence', (p) => print(`${c.dim}· ${t.store.name(p.member)} ${p.online ? 'came online' : 'went offline'}${c.reset}`));
  t.on('status', (s) => print(`${c.dim}· ${t.store.name(s.member)} is on: ${s.status.text}${c.reset}`));
  t.on('member', (m) => print(`${c.dim}· ${m.name}: ${m.state}${m.state === 'pending' ? ` — /approve ${m.name}` : ''}${c.reset}`));
  t.on('pending', () => print('Waiting for a room member to approve you…'));
  const state = await t.connect();
  if (state === 'live') {
    for (const m of t.store.recent(15)) show(m);
    print(`${c.dim}Connected as ${t.cfg.name}. /to <name>, /all, /team, /approve <name>, /quit${c.reset}`);
  }
  rl.on('line', async (line) => {
    const s = line.trim();
    try {
      if (!s) return setPrompt();
      if (s === '/quit' || s === '/exit') { t.close(); process.exit(0); }
      if (s === '/all') { to = null; return setPrompt(); }
      if (s.startsWith('/to ')) { to = t.resolveMember(s.slice(4).trim()); return setPrompt(); }
      if (s === '/team') return print(t.store.members().map((m) => fmtMember(m, t.me)).join('\n'));
      if (s.startsWith('/approve ')) { const m = await t.moderate(s.slice(9).trim(), 'approve'); return print(`approved ${m.name}`); }
      await t.send({ text: s, to: to || undefined });
      setPrompt();
    } catch (e) { print(`! ${e.message}`); }
  });
  rl.on('close', () => { t.close(); process.exit(0); });
  setPrompt();
}

const [cmd = 'help', ...rest] = process.argv.slice(2);
const fn = commands[cmd] || (['-h', '--help'].includes(cmd) ? commands.help : null);
if (!fn) die(`unknown command "${cmd}". Run agentline help.`);
try { await fn(rest); } catch (e) { die(e.message); }
