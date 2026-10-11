// `agentline ui`: a local web chat for the humans. Decryption stays in this process; the browser
// talks only to 127.0.0.1 with a per-run key, so other sites/tabs can't read the room.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomId } from './crypto.mjs';

export async function runUi(t, port = 4545) {
  const key = randomId(12);
  const html = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  const streams = new Set();
  let pending = null;
  const notify = () => {
    clearTimeout(pending);
    pending = setTimeout(() => { for (const res of streams) res.write('event: refresh\ndata: {}\n\n'); }, 40);
  };
  for (const ev of ['message', 'memory', 'member', 'presence', 'status', 'live', 'pending', 'disconnected']) t.on(ev, notify);
  t.connect();

  const state = () => {
    const s = t.store;
    const doc = s.policyDoc();
    return {
      me: { id: t.me, name: t.cfg.name }, room: t.cfg.alias || t.cfg.room, conn: t.state,
      members: s.members(), policy: s.policy(), proposal: doc.proposal,
      messages: s.recent(300), memory: s.memories(),
    };
  };

  const actions = {
    send: ({ text, to, kind }) => t.send({ text, to: to || undefined, kind: kind || 'chat' }),
    remember: ({ key: k, value, tags }) => t.remember(k, value, tags || []),
    forget: ({ key: k }) => t.forget(k),
    moderate: ({ name, action }) => t.moderate(name, action === 'revoke' ? 'revoke' : 'approve'),
    status: ({ text }) => t.setStatus(text),
    policy: ({ propose, accept, reject }) => t.updatePolicy((d) => {
      if (propose) return { ...d, proposal: { settings: propose, by: t.me, at: Date.now(), acks: [t.me] } };
      if (!d.proposal) throw new Error('no open proposal');
      if (reject) return { ...d, proposal: null };
      if (accept) return { ...d, proposal: { ...d.proposal, acks: [...new Set([...d.proposal.acks, t.me])] } };
      return d;
    }),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403).end(); return; } // DNS-rebinding guard
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.searchParams.get('k') !== key && req.headers['x-agentline-key'] !== key) { res.writeHead(401).end(); return; }
    try {
      if (url.pathname === '/api/state') return json(res, state());
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('event: refresh\ndata: {}\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      const m = url.pathname.match(/^\/api\/(\w+)$/);
      if (m && actions[m[1]] && req.method === 'POST') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const r = await actions[m[1]](JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        notify();
        return json(res, { ok: true, r });
      }
      res.writeHead(404).end();
    } catch (e) { json(res, { error: e.message }, 400); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/#k=${key}`;
}

const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
