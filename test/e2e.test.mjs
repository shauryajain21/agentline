// End-to-end: a real hub, two teammates with separate AGENTLINE_HOMEs, two clones of the same repo,
// two real MCP servers over stdio, and the Claude Code hooks fed with realistic stdin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub } from '../src/hub.mjs';
import { openDb } from '../src/sqlite.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'agentline-e2e-'));
const homeA = join(root, 'home-alice'), homeB = join(root, 'home-bob');
const repoA = join(root, 'alice-code', 'demo'), repoB = join(root, 'bob-work', 'demo-checkout');
let hub, A, B;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The hub lives in this process, so child processes must be awaited, never run synchronously.
const cli = async (home, ...args) => (await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, AGENTLINE_HOME: home } })).stdout;
function hook(home, event, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'hook', event], { env: { ...process.env, AGENTLINE_HOME: home } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve(out ? JSON.parse(out) : null) : reject(new Error(err))));
    p.stdin.end(JSON.stringify({ hook_event_name: event, ...input }));
  });
}
const ctx = (out) => out?.hookSpecificOutput?.additionalContext || '';
const text = (r) => r.content.map((c) => c.text).join('\n');

function makeRepo(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'auth.ts'), 'export const TOKEN_TTL = 3600;\nexport function sign(u) {\n  return jwt(u);\n}\n');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('remote', 'add', 'origin', 'git@github.com:linkup/demo.git');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
}

async function mcp(home, cwd) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd, env: { ...process.env, AGENTLINE_HOME: home }, stderr: 'inherit' }));
  return { c, call: async (name, args = {}) => text(await c.callTool({ name, arguments: args })) };
}

before(async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: join(root, 'hub.db'), log: () => {} });
  makeRepo(repoA); makeRepo(repoB);
  const out = await cli(homeA, 'init', '--hub', hub.url, '--name', 'alice', '--alias', 'pair');
  const invite = out.match(/agentline1\.[\w-]+/)[0];
  assert.match(await cli(homeB, 'join', invite, '--name', 'bob'), /approve you/);
  assert.match(await cli(homeA, 'approve', 'bob'), /approved bob/);
  A = await mcp(homeA, repoA);
  B = await mcp(homeB, repoB);
  await sleep(300);
});

after(async () => { await A?.c.close(); await B?.c.close(); await hub?.close(); });

test('exposes the agent toolset with instructions', async () => {
  const { tools } = await A.c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['ask', 'context', 'forget', 'inbox', 'log', 'permissions', 'read', 'recall', 'remember', 'send', 'share', 'status'].sort());
  assert.match(A.c.getInstructions(), /autonomy=ask/);
});

test('status + presence are shared', async () => {
  await A.call('status', { text: 'refactoring token signing in src/auth.ts' });
  await sleep(150);
  const team = await B.call('status');
  assert.match(team, /alice: online — refactoring token signing/);
  assert.match(team, /demo@main/);
});

test('direct message is pushed and appears in inbox once', async () => {
  assert.match(await A.call('send', { text: 'heads up: TOKEN_TTL moving to config', to: 'bob' }), /sent #\d+ → bob/);
  const inbox = await B.call('inbox', { wait_s: 5 });
  assert.match(inbox, /alice \(agent, demo@main\) → you/);
  assert.match(inbox, /TOKEN_TTL moving to config/);
  assert.equal(await B.call('inbox'), 'No new messages.');
});

test('ask waits for the other agent to answer in-thread', async () => {
  const asking = B.call('ask', { question: 'what TTL do you want for refresh tokens?', to: 'alice', wait_s: 15 });
  const q = await A.call('inbox', { wait_s: 5 });
  const id = Number(q.match(/#(\d+) bob.*question/)[1]);
  await A.call('send', { text: '30 days, rotate on use', thread: id });
  const answer = await asking;
  assert.match(answer, /30 days, rotate on use/);
  assert.match(answer, new RegExp(`re #${id}`));
});

test('share a file range and a diff; read returns full content', async () => {
  writeFileSync(join(repoA, 'src', 'auth.ts'), 'export const TOKEN_TTL = Number(process.env.TTL);\nexport function sign(u) {\n  return jwt(u);\n}\n');
  const s = await A.call('share', { note: 'new signing entrypoint', path: 'src/auth.ts', lines: '2-4', diff: 'HEAD' });
  const id = Number(s.match(/#(\d+)/)[1]);
  await sleep(200);
  const full = await B.call('read', { id });
  assert.match(full, /\[file src\/auth\.ts:2-4, 3 lines\]/);
  assert.match(full, /return jwt\(u\);/);
  assert.match(full, /-export const TOKEN_TTL = 3600;/);
});

test('shared memory is two-way', async () => {
  await A.call('remember', { key: 'api/token-format', value: 'JWT, HS256, claims: sub, org, exp', tags: ['auth'] });
  await sleep(150);
  assert.match(await B.call('recall', { key: 'api/token-format' }), /HS256/);
  await B.call('remember', { key: 'decision/db', value: 'Postgres 17 on Neon' });
  await sleep(150);
  assert.match(await A.call('recall', { query: 'postgres' }), /decision\/db/);
  assert.match(await A.call('recall'), /api\/token-format/);
  await B.call('forget', { key: 'decision/db' });
  await sleep(150);
  assert.doesNotMatch(await A.call('recall'), /decision\/db/);
});

test('worklog + overlap detection across clones of the same repo', async () => {
  for (const f of ['src/auth.ts', 'src/config.ts', 'src/auth.ts']) {
    await hook(homeA, 'PostToolUse', { session_id: 'sA', cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, f) } });
  }
  const logged = await A.call('log', { summary: 'Moved TOKEN_TTL to env config; sign() unchanged', next: 'refresh-token rotation' });
  assert.match(logged, /logged #\d+ for demo \(2 files\)/);
  await sleep(200);
  // Bob's agent opens the same file in *their* checkout -> heads-up about Alice's work.
  const out = ctx(await hook(homeB, 'PostToolUse', { session_id: 'sB', cwd: repoB, tool_name: 'Read', tool_input: { file_path: join(repoB, 'src/auth.ts') } }));
  assert.match(out, /Heads-up: alice worked on src\/auth\.ts/);
  assert.match(out, /refresh-token rotation/);
  // only once per file per session
  assert.equal(ctx(await hook(homeB, 'PostToolUse', { session_id: 'sB', cwd: repoB, tool_name: 'Read', tool_input: { file_path: join(repoB, 'src/auth.ts') } })), '');
  const c = await B.call('context', { query: 'TOKEN_TTL' });
  assert.match(c, /Teammate worklogs/);
  assert.match(c, /Moved TOKEN_TTL/);
});

test('session start briefing tells the agent what the teammate did', async () => {
  const out = ctx(await hook(homeB, 'SessionStart', { session_id: 'sB2', cwd: repoB, source: 'startup' }));
  assert.match(out, /linked with alice/);
  assert.match(out, /Moved TOKEN_TTL to env config/);
  assert.match(out, /Shared team memory/);
});

test('teammate messages are injected on the next prompt/tool call', async () => {
  await A.call('send', { text: 'pushed the env change, pull before editing auth', to: 'bob' });
  await sleep(200);
  const out = ctx(await hook(homeB, 'UserPromptSubmit', { session_id: 'sB2', cwd: repoB, prompt: 'continue' }));
  assert.match(out, /\[agentline\] 1 new/);
  assert.match(out, /pull before editing auth/);
  assert.equal(await hook(homeB, 'UserPromptSubmit', { session_id: 'sB2', cwd: repoB, prompt: 'x' }), null); // consumed
});

test('stop hook: unanswered teammate question blocks once, loop-guarded', async () => {
  await A.call('send', { text: 'is the /v2/search endpoint paginated?', to: 'bob', kind: 'question' });
  await sleep(200);
  const out = await hook(homeB, 'Stop', { session_id: 'sB3', cwd: repoB, stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /v2\/search endpoint paginated/);
  assert.equal(await hook(homeB, 'Stop', { session_id: 'sB3', cwd: repoB, stop_hook_active: true }), null);
  assert.equal(await hook(homeB, 'Stop', { session_id: 'sB3', cwd: repoB, stop_hook_active: false }), null);
});

test('stop hook: offers to share a worklog after real edits (autonomy=ask)', async () => {
  for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
    await hook(homeA, 'PostToolUse', { session_id: 'sA2', cwd: repoA, tool_name: 'Write', tool_input: { file_path: join(repoA, f) } });
  }
  const out = await hook(homeA, 'Stop', { session_id: 'sA2', cwd: repoA, stop_hook_active: false });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /offering to share a worklog with bob/);
  assert.equal(await hook(homeA, 'Stop', { session_id: 'sA2', cwd: repoA }), null); // not again right away
});

test('shared permissions need both teammates to agree', async () => {
  assert.match(await A.call('permissions', { propose: { autonomy: 'auto' } }), /waiting for teammates/);
  await sleep(200);
  const b = await B.call('permissions');
  assert.match(b, /Open proposal by alice: \{"autonomy":"auto"\} — waiting on bob/);
  assert.match(b, /autonomy=ask/);
  assert.match(await B.call('permissions', { accept: true }), /new permissions are in effect/);
  await sleep(200);
  assert.match(await A.call('permissions'), /autonomy=auto/);
  // with autonomy=auto, the stop nudge tells the agent to post the log itself
  for (const f of ['src/d.ts', 'src/e.ts', 'src/f.ts']) await hook(homeA, 'PostToolUse', { session_id: 'sA3', cwd: repoA, tool_name: 'Edit', tool_input: { file_path: join(repoA, f) } });
  assert.match((await hook(homeA, 'Stop', { session_id: 'sA3', cwd: repoA })).reason, /Post a concise worklog/);
});

test('hooks fall back to HTTP when no MCP server is live', async () => {
  await B.c.close(); B = null;
  await sleep(200);
  await A.call('send', { text: 'ping while your MCP is down', to: 'bob' });
  const out = ctx(await hook(homeB, 'UserPromptSubmit', { session_id: 'sB4', cwd: repoB, prompt: 'hi' }));
  assert.match(out, /ping while your MCP is down/);
});

test('hub stores only ciphertext', () => {
  const db = openDb(join(root, 'hub.db'));
  const dump = JSON.stringify([
    db.prepare('SELECT blob FROM messages').all(),
    db.prepare('SELECT kid, blob FROM memory').all(),
    db.prepare('SELECT status_blob FROM members').all(),
  ]);
  for (const secret of ['TOKEN_TTL', 'auth.ts', 'api/token-format', 'HS256', 'refactoring', 'paginated', 'autonomy']) {
    assert.ok(!dump.includes(secret), `hub leaked "${secret}"`);
  }
  db.close();
});
