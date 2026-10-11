// The hub: a dumb, fast relay. It authenticates members, orders messages, fans them out over
// WebSockets and stores ciphertext. It never sees plaintext — message bodies, memory keys/values
// and statuses are all sealed client-side with the room key.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { openDb } from './sqlite.mjs';
import { sha256, randomId, safeEqual } from './crypto.mjs';

import { VERSION } from './version.mjs';
export { VERSION };
const MAX_BLOB = 2_000_000;         // ~1.5MB of plaintext per message
const KEEP_MESSAGES = 20_000;       // per room
const FRESH_BACKLOG = 200;          // messages sent to a brand-new client
const MAX_BACKLOG = 1000;

export function startHub({ port = 8787, host = '0.0.0.0', dbPath = 'agentline-hub.db', log = console.error } = {}) {
  const db = openDb(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, verifier TEXT NOT NULL, require_approval INT NOT NULL,
      seq INT NOT NULL DEFAULT 0, memver INT NOT NULL DEFAULT 0, created_at INT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(room TEXT, id TEXT, name TEXT, token_hash TEXT, state TEXT, role TEXT,
      created_at INT, last_seen INT, status_blob TEXT, status_ts INT, PRIMARY KEY(room, id));
    CREATE TABLE IF NOT EXISTS messages(room TEXT, seq INT, sender TEXT, recipient TEXT, ts INT, blob TEXT,
      PRIMARY KEY(room, seq)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS memory(room TEXT, kid TEXT, ver INT, author TEXT, ts INT, blob TEXT, deleted INT,
      PRIMARY KEY(room, kid));
    CREATE INDEX IF NOT EXISTS memory_ver ON memory(room, ver);
  `);
  const q = Object.fromEntries(Object.entries({
    room: 'SELECT * FROM rooms WHERE id=?',
    insRoom: 'INSERT INTO rooms(id, verifier, require_approval, created_at) VALUES(?,?,?,?)',
    member: 'SELECT * FROM members WHERE room=? AND id=?',
    members: 'SELECT * FROM members WHERE room=? ORDER BY created_at',
    memberByName: "SELECT * FROM members WHERE room=? AND lower(name)=lower(?) AND state!='revoked'",
    insMember: 'INSERT INTO members(room,id,name,token_hash,state,role,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    setState: 'UPDATE members SET state=? WHERE room=? AND id=?',
    seen: 'UPDATE members SET last_seen=? WHERE room=? AND id=?',
    setStatus: 'UPDATE members SET status_blob=?, status_ts=? WHERE room=? AND id=?',
    bumpSeq: 'UPDATE rooms SET seq=seq+1 WHERE id=? RETURNING seq',
    bumpMem: 'UPDATE rooms SET memver=memver+1 WHERE id=? RETURNING memver',
    insMsg: 'INSERT INTO messages(room,seq,sender,recipient,ts,blob) VALUES(?,?,?,?,?,?)',
    trimMsgs: 'DELETE FROM messages WHERE room=? AND seq<=?',
    msgsSince: `SELECT seq,sender,recipient,ts,blob FROM messages WHERE room=? AND seq>?
      AND (recipient IS NULL OR recipient=? OR sender=?) ORDER BY seq DESC LIMIT ?`,
    mem: 'SELECT ver FROM memory WHERE room=? AND kid=?',
    upMem: `INSERT INTO memory(room,kid,ver,author,ts,blob,deleted) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room,kid) DO UPDATE SET ver=excluded.ver, author=excluded.author, ts=excluded.ts,
      blob=excluded.blob, deleted=excluded.deleted`,
    memSince: 'SELECT kid,ver,author,ts,blob,deleted FROM memory WHERE room=? AND ver>? ORDER BY ver',
  }).map(([k, sql]) => [k, db.prepare(sql)]));

  const conns = new Map(); // roomId -> Set<{ws, member}>
  const roomConns = (room) => conns.get(room) || conns.set(room, new Set()).get(room);
  const now = () => Date.now();
  const online = (room, id) => [...roomConns(room)].some((c) => c.member === id && c.active);

  const publicMember = (m) => ({
    id: m.id, name: m.name, state: m.state, role: m.role, lastSeen: m.last_seen,
    online: online(m.room, m.id), status: m.status_blob, statusTs: m.status_ts,
  });

  function broadcast(room, payload, { to = null, except = null } = {}) {
    const data = JSON.stringify(payload);
    for (const c of roomConns(room)) {
      if (!c.active || c === except) continue;
      if (to && c.member !== to && c.member !== payload.from) continue;
      c.ws.send(data);
    }
  }

  // ---- core operations shared by HTTP and WS ----------------------------------------------------
  function authenticate(room, memberId, token) {
    const m = q.member.get(room, memberId);
    if (!m || m.state === 'revoked' || !safeEqual(m.token_hash, sha256(String(token)))) return null;
    return m;
  }

  function snapshot(m, since = 0, memSince = 0) {
    const r = q.room.get(m.room);
    const limit = since > 0 ? MAX_BACKLOG : FRESH_BACKLOG;
    const msgs = q.msgsSince.all(m.room, since, m.id, m.id, limit).reverse()
      .map((x) => ({ seq: x.seq, from: x.sender, to: x.recipient, ts: x.ts, blob: x.blob }));
    const mems = q.memSince.all(m.room, memSince).map((x) => ({ ...x, deleted: !!x.deleted }));
    return {
      me: { id: m.id, name: m.name, role: m.role, state: m.state },
      room: { id: r.id, requireApproval: !!r.require_approval, seq: r.seq, memver: r.memver },
      members: q.members.all(m.room).filter((x) => x.state !== 'revoked').map(publicMember),
      msgs, mems,
    };
  }

  function send(m, to, blob) {
    if (typeof blob !== 'string' || blob.length > MAX_BLOB) throw err(413, 'message too large');
    if (to && !q.member.get(m.room, to)) throw err(404, 'no such recipient');
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    let seq;
    try {
      seq = q.bumpSeq.get(m.room).seq;
      q.insMsg.run(m.room, seq, m.id, to || null, ts, blob);
      if (seq % 500 === 0) q.trimMsgs.run(m.room, seq - KEEP_MESSAGES);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast(m.room, { op: 'msg', seq, from: m.id, to: to || null, ts, blob }, { to: to || null });
    return { seq, ts };
  }

  function putMemory(m, { kid, blob, base, del }) {
    if (typeof kid !== 'string' || kid.length > 100) throw err(400, 'bad kid');
    if (!del && (typeof blob !== 'string' || blob.length > MAX_BLOB)) throw err(413, 'memory value too large');
    db.exec('BEGIN IMMEDIATE');
    let ver, ts = now();
    try {
      const cur = q.mem.get(m.room, kid);
      if (base !== undefined && base !== null && (cur?.ver ?? 0) !== base) {
        throw err(409, 'conflict', { current: cur?.ver ?? 0 });
      }
      ver = q.bumpMem.get(m.room).memver;
      q.upMem.run(m.room, kid, ver, m.id, ts, del ? null : blob, del ? 1 : 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast(m.room, { op: 'mem', kid, ver, author: m.id, ts, blob: del ? null : blob, deleted: !!del });
    return { ver, ts };
  }

  function setStatus(m, blob) {
    if (typeof blob !== 'string' || blob.length > 20_000) throw err(413, 'status too large');
    const ts = now();
    q.setStatus.run(blob, ts, m.room, m.id);
    broadcast(m.room, { op: 'status', member: m.id, blob, ts });
    return { ts };
  }

  function moderate(m, targetId, action) {
    if (m.state !== 'active') throw err(403, 'only active members can approve or revoke');
    const t = q.member.get(m.room, targetId) || q.memberByName.get(m.room, targetId);
    if (!t) throw err(404, 'no such member');
    const state = action === 'approve' ? 'active' : 'revoked';
    q.setState.run(state, m.room, t.id);
    const updated = q.member.get(m.room, t.id);
    broadcast(m.room, { op: 'member', member: publicMember(updated) });
    for (const c of roomConns(m.room)) {
      if (c.member !== t.id) continue;
      if (state === 'active' && !c.active) welcome(c, 0, 0);
      if (state === 'revoked') c.ws.close(4003, 'revoked');
    }
    return publicMember(updated);
  }

  function welcome(c, since, memSince) {
    const m = q.member.get(c.room, c.member);
    c.active = true;
    q.seen.run(now(), c.room, c.member);
    c.ws.send(JSON.stringify({ op: 'welcome', v: VERSION, ...snapshot(m, since, memSince) }));
    broadcast(c.room, { op: 'presence', member: c.member, online: true }, { except: c });
  }

  // ---- HTTP -----------------------------------------------------------------------------------------
  const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

  async function body(req) {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > MAX_BLOB * 1.5) throw err(413, 'body too large'); chunks.push(ch); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw err(400, 'invalid json'); }
  }

  function bearer(req, room) {
    const [memberId, token] = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.');
    const m = authenticate(room, memberId, token);
    if (!m) throw err(401, 'unauthorized');
    return m;
  }

  const routes = [
    ['GET', /^\/health$/, () => ({ ok: true, name: 'agentline-hub', version: VERSION })],
    ['POST', /^\/v1\/rooms$/, async (req) => {
      const { room, verifier, name, requireApproval = true } = await body(req);
      if (!/^[\w-]{8,64}$/.test(room || '') || !verifier || !name) throw err(400, 'room, verifier and name required');
      if (q.room.get(room)) throw err(409, 'room exists');
      const id = randomId(), token = randomId(24), ts = now();
      q.insRoom.run(room, verifier, requireApproval ? 1 : 0, ts);
      q.insMember.run(room, id, String(name).slice(0, 40), sha256(token), 'active', 'owner', ts, ts);
      return { member: id, token, state: 'active' };
    }],
    ['POST', /^\/v1\/rooms\/([\w-]+)\/join$/, async (req, [, room]) => {
      const { auth, name } = await body(req);
      const r = q.room.get(room);
      if (!r || !auth || !safeEqual(r.verifier, sha256(Buffer.from(auth, 'base64url')))) throw err(403, 'invalid invite');
      if (!name) throw err(400, 'name required');
      if (q.memberByName.get(room, name)) throw err(409, `name "${name}" is taken in this room`);
      const id = randomId(), token = randomId(24), ts = now();
      const state = r.require_approval ? 'pending' : 'active';
      q.insMember.run(room, id, String(name).slice(0, 40), sha256(token), state, 'member', ts, ts);
      broadcast(room, { op: 'member', member: publicMember(q.member.get(room, id)) });
      return { member: id, token, state };
    }],
    ['GET', /^\/v1\/rooms\/([\w-]+)\/sync$/, (req, [, room], url) => {
      const m = bearer(req, room);
      if (m.state !== 'active') return { pending: true, me: { id: m.id, name: m.name, state: m.state } };
      q.seen.run(now(), room, m.id);
      return snapshot(m, Number(url.searchParams.get('since') || 0), Number(url.searchParams.get('memSince') || 0));
    }],
    ['POST', /^\/v1\/rooms\/([\w-]+)\/messages$/, async (req, [, room]) => {
      const m = active(bearer(req, room)); const { to, blob } = await body(req); return send(m, to, blob);
    }],
    ['POST', /^\/v1\/rooms\/([\w-]+)\/memory$/, async (req, [, room]) => putMemory(active(bearer(req, room)), await body(req))],
    ['POST', /^\/v1\/rooms\/([\w-]+)\/status$/, async (req, [, room]) => setStatus(active(bearer(req, room)), (await body(req)).blob)],
    ['POST', /^\/v1\/rooms\/([\w-]+)\/members\/([\w-]+)\/(approve|revoke)$/, (req, [, room, target, action]) =>
      moderate(bearer(req, room), target, action)],
  ];
  const active = (m) => { if (m.state !== 'active') throw err(403, 'awaiting approval from a room member'); return m; };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    try {
      for (const [method, re, fn] of routes) {
        const match = url.pathname.match(re);
        if (match && req.method === method) {
          res.end(JSON.stringify(await fn(req, match, url)));
          return;
        }
      }
      throw err(404, 'not found');
    } catch (e) {
      res.statusCode = e.status || 500;
      if (!e.status) log('[hub] error', e);
      res.end(JSON.stringify({ error: e.message, ...e.extra }));
    }
  });

  // ---- WebSocket --------------------------------------------------------------------------------------
  const wss = new WebSocketServer({ server, path: '/v1/ws', maxPayload: MAX_BLOB * 2 });
  wss.on('connection', (ws) => {
    let c = null;
    const reply = (id, data) => ws.send(JSON.stringify({ op: 'ack', id, ...data }));
    const fail = (id, e) => ws.send(JSON.stringify({ op: 'nack', id, error: e.message, status: e.status || 500, ...e.extra }));
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10_000);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return ws.close(4000, 'bad json'); }
      if (msg.op === 'ping') return ws.send('{"op":"pong"}');
      if (!c) {
        if (msg.op !== 'hello') return ws.close(4001, 'expected hello');
        clearTimeout(helloTimer);
        const m = authenticate(msg.room, msg.member, msg.token);
        if (!m) return ws.close(4003, 'unauthorized');
        c = { ws, room: m.room, member: m.id, active: false };
        roomConns(m.room).add(c);
        if (m.state === 'active') welcome(c, Number(msg.since) || 0, Number(msg.memSince) || 0);
        else ws.send(JSON.stringify({ op: 'pending', me: { id: m.id, name: m.name } }));
        return;
      }
      const m = q.member.get(c.room, c.member);
      try {
        if (msg.op !== 'approve' && msg.op !== 'revoke' && (!c.active || m.state !== 'active')) throw err(403, 'awaiting approval');
        switch (msg.op) {
          case 'send': return reply(msg.id, send(m, msg.to, msg.blob));
          case 'mem': return reply(msg.id, putMemory(m, msg));
          case 'status': return reply(msg.id, setStatus(m, msg.blob));
          case 'approve': case 'revoke': return reply(msg.id, { member: moderate(m, msg.member, msg.op) });
          default: throw err(400, `unknown op ${msg.op}`);
        }
      } catch (e) { fail(msg.id, e); }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!c) return;
      roomConns(c.room).delete(c);
      q.seen.run(now(), c.room, c.member);
      if (c.active && !online(c.room, c.member)) broadcast(c.room, { op: 'presence', member: c.member, online: false });
    });
  });

  // Drop dead sockets (laptops closing lids) so presence stays honest.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 25_000);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: p } = server.address();
      resolve({
        port: p, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}`,
        close: () => new Promise((r) => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(() => { db.close(); r(); }); }),
      });
    });
  });
}
