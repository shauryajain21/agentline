// End-to-end: a real hub, two teammates with separate AGENTLINE_HOMEs, two clones of the same repo,
// two real MCP servers over stdio, the Claude Code hooks fed with realistic stdin, and a realistic
// Claude Code transcript that alice shares and bob's agent queries.
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

// A Claude Code transcript (JSONL) the way Claude Code writes it.
function transcript(file, turns) {
  const line = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type === 'user' ? 'user' : 'assistant', content }, ...extra });
  const out = [JSON.stringify({ type: 'queue-operation', operation: 'enqueue' })];
  for (const [prompt, reply, cmd, result] of turns) {
    out.push(line('user', `<system-reminder>internal note</system-reminder>${prompt}`));
    out.push(line('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: reply }]));
    if (cmd) {
      out.push(line('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }]));
      out.push(line('user', [{ type: 'tool_result', tool_use_id: 't1', content: result }]));
    }
  }
  out.push(line('user', 'side quest', { isSidechain: true }));
  writeFileSync(file, out.join('\n') + '\n');
}
const transcriptA = join(root, 'alice-session.jsonl');
const OPENAI_KEY = 'sk-proj-' + 'Abc123'.repeat(10);

test('exposes only the session-sharing tools', async () => {
  const { tools } = await A.c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['permissions', 'query_session', 'share_session', 'shared_sessions']);
  assert.match(A.c.getInstructions(), /ONLY when your human explicitly asks/);
});

test('nothing is shared unless asked: hooks only record the session', async () => {
  transcript(transcriptA, [
    ['let us add cursor pagination to search()', 'Plan: switch search() to cursor pagination in src/search.ts.', 'npm test', 'ok 12 tests'],
    [`deploy with OPENAI_API_KEY=${OPENAI_KEY}`, 'Deployed to Railway; hub at https://hub.example.com', 'railway up', 'Deploy complete'],
  ]);
  const before = (await B.call('shared_sessions'));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
    await hook(homeA, ev, { session_id: 'sA', cwd: repoA, transcript_path: transcriptA, prompt: 'hi', tool_name: 'Edit', tool_input: { file_path: join(repoA, 'src/auth.ts') } });
  }
  await sleep(200);
  assert.equal(before, 'No sessions have been shared yet.');
  assert.equal(await B.call('shared_sessions'), 'No sessions have been shared yet.');
  const db = openDb(join(root, 'hub.db'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  db.close();
});

test('share_session sends the current session, redacted', async () => {
  const out = await A.call('share_session', { to: 'bob', title: 'search pagination' });
  assert.match(out, /shared this session as #\d+ → bob: "search pagination", 8 entries/);
  await sleep(200);
  assert.match(await B.call('shared_sessions'), /#\d+ alice → you · "search pagination" · 8 entries · demo@main/);
  // bob's next prompt mentions it once
  assert.match(ctx(await hook(homeB, 'UserPromptSubmit', { session_id: 'sB', cwd: repoB, transcript_path: join(root, 'b.jsonl'), prompt: 'hi' })), /alice's session "search pagination"/);
  assert.equal(await hook(homeB, 'UserPromptSubmit', { session_id: 'sB', cwd: repoB, prompt: 'again' }), null);
});

test('the teammate agent can query the shared session', async () => {
  const outline = await B.call('query_session', { from: 'alice' });
  assert.match(outline, /Session #\d+ shared by alice .*"search pagination"/);
  assert.match(outline, /\[1\] USER: let us add cursor pagination to search\(\)/);
  assert.ok(!outline.includes('internal note') && !outline.includes('private reasoning') && !outline.includes('side quest'));

  const hit = await B.call('query_session', { query: 'railway deploy' });
  assert.match(hit, /AGENT: Deployed to Railway/);
  assert.ok(!hit.includes(OPENAI_KEY), 'API key leaked');
  assert.match(hit, /OPENAI_API_KEY=\[REDACTED\]/);

  const range = await B.call('query_session', { entries: '3-4' });
  assert.match(range, /\[3\] TOOL CALL: Bash: npm test\n\[4\] TOOL OUTPUT: ok 12 tests/);
  assert.match(await B.call('query_session', { query: 'kubernetes' }), /Nothing matches/);
});

test('sharing again replaces the older copy', async () => {
  transcript(transcriptA, [
    ['let us add cursor pagination to search()', 'Plan: cursor pagination.'],
    ['also update the UI callers', 'Updated web/SearchList.tsx to pass the cursor.'],
  ]);
  await A.call('share_session', { to: 'bob', title: 'search pagination' });
  await sleep(200);
  const list = await B.call('shared_sessions');
  assert.equal(list.split('\n').length, 1);
  assert.match(await B.call('query_session', { query: 'UI callers' }), /SearchList\.tsx/);
});

test('a huge session is trimmed to fit one message', async () => {
  const big = join(root, 'big.jsonl');
  const noise = () => Array.from({ length: 4000 }, () => Math.random().toString(36).slice(2)).join(' ');
  transcript(big, Array.from({ length: 60 }, (_, i) => [`step ${i}`, `did step ${i}`, 'cat log', noise()]));
  await hook(homeA, 'UserPromptSubmit', { session_id: 'sBig', cwd: repoA, transcript_path: big, prompt: 'share it' });
  assert.match(await A.call('share_session', { title: 'big one' }), /shared this session as #\d+ → everyone: "big one", \d+ entries/);
});

test('hub stores only ciphertext', () => {
  const db = openDb(join(root, 'hub.db'));
  const dump = JSON.stringify([db.prepare('SELECT blob FROM messages').all(), db.prepare('SELECT status_blob FROM members').all()]);
  for (const secret of ['pagination', 'Railway', 'SearchList', 'search()', OPENAI_KEY]) {
    assert.ok(!dump.includes(secret), `hub leaked "${secret}"`);
  }
  db.close();
});
