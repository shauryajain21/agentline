// Local demo: hub + two teammates (separate AGENTLINE_HOMEs) + seeded agent traffic + the web UI.
//   node scripts/demo.mjs [--port 4545]
// Nothing touches your real ~/.agentline.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startHub } from '../src/hub.mjs';
import { b64u, deriveKeys, verifierFor, randomId } from '../src/crypto.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentline-demo-'));
const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'hub.db'), log: () => {} });
const room = randomId(9), secret = b64u(randomBytes(32));
const keys = deriveKeys(secret, room);
const post = (path, body) => fetch(hub.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const a = await post('/v1/rooms', { room, verifier: verifierFor(keys.auth), name: 'alice' });
const b = await post(`/v1/rooms/${room}/join`, { auth: b64u(keys.auth), name: 'bob' });
const cfg = (who, r) => ({ hub: hub.url, room, secret, member: r.member, token: r.token, name: who, alias: 'alice+bob' });

// Each teammate gets an isolated AGENTLINE_HOME; Store resolves it at construction time.
const { Agentline } = await import('../src/client.mjs');
process.env.AGENTLINE_HOME = join(dir, 'bob');
const adv = new Agentline(cfg('bob', b), { via: 'agent', cwd: process.cwd() });
process.env.AGENTLINE_HOME = join(dir, 'alice');
const sha = new Agentline(cfg('alice', a), { via: 'agent', cwd: process.cwd() });
await sha.connect();
await sha.moderate('bob', 'approve');
await adv.connect();
await new Promise((r) => setTimeout(r, 200));

await adv.setStatus('adding group rooms to the hub — touching src/hub.mjs');
await sha.setStatus('deploying the hub to Fly + writing the onboarding README');
await adv.send({ kind: 'worklog', worklog: {
  summary: 'Built the overlap detector MVP: PostToolUse records files per session; when you open a file your teammate touched in the last 7 days, your agent gets a one-line heads-up. Works across different clone paths via the git remote.',
  files: ['src/hook.mjs', 'src/store.mjs', 'src/project.mjs', 'test/e2e.test.mjs'],
  next: 'Group rooms (3+ people) and per-thread mute; want a review of hook.mjs before I go further', project: sha.project.id } });
await adv.remember('decision/e2e-crypto', 'Hub only ever sees ciphertext. Room secret -> HKDF -> enc/auth/mem keys. Rotating = new room.', ['decision', 'security']);
await sha.remember('convention/worklogs', 'Post a worklog after every meaningful chunk: what + files + next. No more written dailies.', ['process']);
await adv.send({ kind: 'share', text: 'The message envelope, so your agent can render worklogs in the UI', attachments: [{ type: 'file', path: 'src/client.mjs', lines: '160-166', lang: 'js',
  content: "async send({ to, kind = 'chat', text = '', thread, attachments, worklog, urgent }) {\n  const body = { kind, text, session: this.session(), thread, attachments, worklog, urgent };\n  const blob = this.sealMsg(body);            // AES-256-GCM, room key\n  const r = await this.request('send', { to, blob }, '/messages');\n  return { seq: r.seq, ts: r.ts };\n}" }] });
const q = await sha.send({ kind: 'question', to: 'bob', text: 'Does the overlap alert fire for files I only *read*, or just edits? Writing the README section now.' });
await adv.send({ kind: 'answer', thread: q.seq, to: 'alice', text: 'Both reads and edits trigger it (once per file per session), but only *edits* count toward the Stop-hook worklog nudge.' });
await sha.send({ text: 'Perfect, documenting that. Reviewing hook.mjs after lunch.' });

const { runUi } = await import('../src/ui.mjs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4545;
const url = await runUi(sha, port);
console.log(`demo hub: ${hub.url}\nUI (as alice): ${url}\nCtrl-C to stop.`);
setInterval(() => {}, 1 << 30);
