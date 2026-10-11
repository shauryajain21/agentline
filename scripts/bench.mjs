// Latency check: agent→agent delivery over the hub, and hook overhead per tool call.
//   node scripts/bench.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub } from '../src/hub.mjs';
import { b64u, deriveKeys, verifierFor, randomId } from '../src/crypto.mjs';
import { putRoom } from '../src/config.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentline-bench-'));
const hub = await startHub({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'hub.db'), log: () => {} });
const room = randomId(9), secret = b64u(randomBytes(32)), keys = deriveKeys(secret, room);
const post = (p, b) => fetch(hub.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const a = await post('/v1/rooms', { room, verifier: verifierFor(keys.auth), name: 'a', requireApproval: false });
const b = await post(`/v1/rooms/${room}/join`, { auth: b64u(keys.auth), name: 'b' });
const cfg = (n, r) => ({ hub: hub.url, room, secret, member: r.member, token: r.token, name: n });

const { Agentline } = await import('../src/client.mjs');
process.env.AGENTLINE_HOME = join(dir, 'a'); const A = new Agentline(cfg('a', a)); await A.connect();
process.env.AGENTLINE_HOME = join(dir, 'b'); putRoom(cfg('b', b)); const B = new Agentline(cfg('b', b)); await B.connect();

const pct = (xs, p) => xs.sort((x, y) => x - y)[Math.floor(xs.length * p)].toFixed(2);
const lat = [];
for (let i = 0; i < 300; i++) {
  const t0 = performance.now();
  const got = B.waitForMessage(5000);
  await A.send({ text: `ping ${i} `.repeat(20) });
  await got;
  lat.push(performance.now() - t0);
}
console.log(`agent→agent delivery (encrypt → hub → fan-out → decrypt → local store), n=300: p50 ${pct(lat, 0.5)}ms  p95 ${pct(lat, 0.95)}ms`);

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const runHook = (event, input) => new Promise((res) => {
  const t0 = performance.now();
  const p = spawn(process.execPath, [CLI, 'hook', event], { env: { ...process.env, AGENTLINE_HOME: join(dir, 'b') } });
  p.stdout.resume();
  p.on('close', () => res(performance.now() - t0));
  p.stdin.end(JSON.stringify(input));
});
const hk = [];
for (let i = 0; i < 20; i++) hk.push(await runHook('PostToolUse', { session_id: 's', cwd: process.cwd(), tool_name: 'Edit', tool_input: { file_path: join(process.cwd(), 'src/hub.mjs') } }));
console.log(`PostToolUse hook wall time incl. node startup (live replica, no network), n=20: p50 ${pct(hk, 0.5)}ms  p95 ${pct(hk, 0.95)}ms`);

A.close(); B.close(); await hub.close();
process.exit(0);
