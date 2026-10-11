// Room client: one WebSocket to the hub, transparent E2E crypto, a local replica (Store) and
// an HTTP fallback so short-lived processes (hooks, CLI) work without holding a socket.
import { EventEmitter } from 'node:events';
import { deriveKeys, seal, open, memKid, randomId } from './crypto.mjs';
import { Store } from './store.mjs';
import { projectInfo, sessionLabel } from './project.mjs';

const aad = (room, purpose) => `${room}|${purpose}`;
export const LIVE_MS = 15_000; // a heartbeat younger than this means "the local replica is live"

export class Agentline extends EventEmitter {
  constructor(cfg, { via = 'agent', cwd = process.cwd() } = {}) {
    super();
    this.cfg = cfg;
    this.via = via;
    this.cwd = cwd;
    this.keys = deriveKeys(cfg.secret, cfg.room);
    this.store = new Store(cfg.room);
    this.me = cfg.member;
    this.pendingAcks = new Map();
    this.state = 'idle'; // idle | connecting | live | pending | closed
    this.backoff = 500;
  }

  /** Git identity of the working dir, cached in the replica for a minute (hooks run on every tool call). */
  get project() {
    if (this._project) return this._project;
    const k = `proj:${this.cwd}`, hit = this.store.get(k);
    if (hit && Date.now() - hit.at < 60_000) return (this._project = hit.info);
    const info = projectInfo(this.cwd);
    this.store.set(k, { at: Date.now(), info });
    return (this._project = info);
  }
  session() { const p = this.project; return { project: p.id, label: sessionLabel(p), via: this.via }; }

  // ---------------- crypto helpers
  sealMsg(body) { return seal(this.keys.enc, body, aad(this.cfg.room, 'msg')); }
  openMsg(blob) { return open(this.keys.enc, blob, aad(this.cfg.room, 'msg')); }
  kid(key) { return memKid(this.keys.mem, key); }

  ingestMsg(m) {
    let body;
    try { body = this.openMsg(m.blob); } catch { return null; } // not for our key — ignore
    const msg = { seq: m.seq, from: m.from, to: m.to, ts: m.ts, body };
    this.store.addMessage(msg, m.from === this.me);
    if (m.seq > this.store.get('seq', 0)) this.store.set('seq', m.seq);
    return msg;
  }

  ingestMem(m) {
    let plain = {};
    if (!m.deleted && m.blob) {
      try { plain = open(this.keys.enc, m.blob, aad(this.cfg.room, 'mem')); } catch { return null; }
    }
    const row = { kid: m.kid, key: plain.key, value: plain.value, tags: plain.tags, author: m.author, ts: m.ts, ver: m.ver, deleted: m.deleted };
    if (m.deleted) {
      const prev = this.store.memoryRaw(m.kid);
      row.key = prev?.key; row.value = null;
    }
    this.store.putMemory(row);
    if (m.ver > this.store.get('memver', 0)) this.store.set('memver', m.ver);
    return row;
  }

  ingestMember(m) {
    let status = null;
    if (m.status) { try { status = open(this.keys.enc, m.status, aad(this.cfg.room, 'status')); } catch { /* ignore */ } }
    this.store.putMember({ ...m, status: status ? JSON.stringify(status) : null });
  }

  ingestSnapshot(s) {
    this.store.db.exec('BEGIN');
    try {
      this.store.set('me', s.me);
      this.store.set('room', s.room);
      for (const m of s.members) this.ingestMember(m);
      for (const m of s.mems) this.ingestMem(m);
      for (const m of s.msgs) this.ingestMsg(m);
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }

  // ---------------- live connection
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    this.openSocket();
    return this.ready;
  }

  async openSocket() {
    if (this.state === 'closed') return;
    const { default: WebSocket } = await import('ws'); // lazy: hooks/CLI never pay for it
    if (this.state === 'closed') return;
    this.state = 'connecting';
    const url = this.cfg.hub.replace(/^http/, 'ws').replace(/\/$/, '') + '/v1/ws';
    const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        op: 'hello', room: this.cfg.room, member: this.me, token: this.cfg.token,
        since: this.store.get('seq', 0), memSince: this.store.get('memver', 0),
      }));
    });
    ws.on('message', (raw) => this.onFrame(JSON.parse(raw)));
    ws.on('error', (e) => this.emit('neterror', e));
    ws.on('close', (code, reason) => {
      clearInterval(this.liveTimer);
      const wasLive = this.state === 'live';
      for (const [, p] of this.pendingAcks) p.reject(new Error('connection lost'));
      this.pendingAcks.clear();
      if (this.state === 'closed') return;
      if (code === 4003) { this.state = 'closed'; this.emit('revoked', String(reason)); this.resolveReady?.('unauthorized'); return; }
      this.state = 'connecting';
      if (wasLive) this.emit('disconnected');
      setTimeout(() => this.openSocket(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    });
  }

  onFrame(f) {
    switch (f.op) {
      case 'welcome': {
        this.ingestSnapshot(f);
        this.state = 'live';
        this.backoff = 500;
        this.heartbeat();
        clearInterval(this.liveTimer);
        this.liveTimer = setInterval(() => this.heartbeat(), 5000);
        this.liveTimer.unref?.();
        this.emit('live', f);
        this.resolveReady?.('live');
        break;
      }
      case 'pending': this.state = 'pending'; this.emit('pending', f.me); this.resolveReady?.('pending'); break;
      case 'msg': { const m = this.ingestMsg(f); if (m) this.emit('message', m); break; }
      case 'mem': { const m = this.ingestMem(f); if (m) this.emit('memory', m); break; }
      case 'status': {
        let s = null; try { s = open(this.keys.enc, f.blob, aad(this.cfg.room, 'status')); } catch { break; }
        this.store.status(f.member, s, f.ts); this.emit('status', { member: f.member, status: s }); break;
      }
      case 'presence': this.store.presence(f.member, f.online); this.emit('presence', f); break;
      case 'member': this.ingestMember(f.member); this.emit('member', f.member); break;
      case 'ack': case 'nack': {
        const p = this.pendingAcks.get(f.id);
        if (!p) break;
        this.pendingAcks.delete(f.id);
        if (f.op === 'ack') p.resolve(f);
        else p.reject(Object.assign(new Error(f.error), { status: f.status, current: f.current }));
        break;
      }
    }
  }

  heartbeat() { this.store.set('live', Date.now()); }

  close() {
    this.state = 'closed';
    clearInterval(this.liveTimer);
    this.ws?.close();
    this.store.set('live', 0);
  }

  // ---------------- requests: WS when live, HTTP otherwise
  async request(op, payload, httpPath) {
    if (this.state === 'live' && this.ws?.readyState === 1 /* OPEN */) {
      const id = randomId(4);
      const ack = new Promise((resolve, reject) => {
        this.pendingAcks.set(id, { resolve, reject });
        setTimeout(() => { if (this.pendingAcks.delete(id)) reject(new Error('hub did not acknowledge in 10s')); }, 10_000).unref?.();
      });
      this.ws.send(JSON.stringify({ op, id, ...payload }));
      return ack;
    }
    return this.http('POST', httpPath, payload);
  }

  async http(method, path, payload) {
    const res = await fetch(this.cfg.hub.replace(/\/$/, '') + `/v1/rooms/${this.cfg.room}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.me}.${this.cfg.token}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(this.httpTimeout || 8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `hub returned ${res.status}`), { status: res.status, current: data.current });
    return data;
  }

  /** One-shot pull of everything new — used by hooks/CLI when no live MCP process is around. */
  async sync() {
    const s = await this.http('GET', `/sync?since=${this.store.get('seq', 0)}&memSince=${this.store.get('memver', 0)}`);
    if (s.pending) return { pending: true };
    this.ingestSnapshot(s);
    return { pending: false, newMessages: s.msgs.length };
  }

  isLive() { return Date.now() - this.store.get('live', 0) < LIVE_MS; }

  // ---------------- high-level API
  resolveMember(nameOrId) {
    if (!nameOrId || nameOrId === 'all' || nameOrId === 'everyone') return null;
    const all = this.store.members();
    const m = all.find((x) => x.id === nameOrId) || all.find((x) => x.name.toLowerCase() === String(nameOrId).toLowerCase().replace(/^@/, ''));
    if (!m) throw new Error(`No member "${nameOrId}". Members: ${all.map((x) => x.name).join(', ')}`);
    return m.id;
  }

  async send({ to, kind = 'chat', text = '', thread, attachments, worklog, urgent, extra }) {
    const body = { kind, text, session: this.session(), ...(thread && { thread }), ...(attachments?.length && { attachments }),
      ...(worklog && { worklog }), ...(urgent && { urgent: true }), ...extra };
    const blob = this.sealMsg(body);
    const toId = this.resolveMember(to);
    const r = await this.request('send', { to: toId, blob }, '/messages');
    this.store.addMessage({ seq: r.seq, from: this.me, to: toId, ts: r.ts, body }, true);
    return { seq: r.seq, ts: r.ts };
  }

  async remember(key, value, tags = [], base) {
    const blob = seal(this.keys.enc, { key, value, tags }, aad(this.cfg.room, 'mem'));
    const kid = this.kid(key);
    const r = await this.request('mem', { kid, blob, ...(base !== undefined && { base }) }, '/memory');
    this.store.putMemory({ kid, key, value, tags, author: this.me, ts: r.ts, ver: r.ver, deleted: false });
    return r;
  }

  async forget(key) {
    const kid = this.kid(key);
    const r = await this.request('mem', { kid, del: true }, '/memory');
    this.store.putMemory({ kid, key, value: null, tags: [], author: this.me, ts: r.ts, ver: r.ver, deleted: true });
    return r;
  }

  recall(key) { return this.store.memory(this.kid(key)); }

  async setStatus(text) {
    const status = { text, ...this.session() };
    const blob = seal(this.keys.enc, status, aad(this.cfg.room, 'status'));
    const r = await this.request('status', { blob }, '/status');
    this.store.status(this.me, status, r.ts);
    return r;
  }

  async moderate(nameOrId, action) {
    const target = this.store.members().find((x) => x.id === nameOrId || x.name.toLowerCase() === String(nameOrId).toLowerCase());
    const id = target?.id || nameOrId;
    if (this.state === 'live') return (await this.request(action, { member: id })).member;
    return this.http('POST', `/members/${id}/${action}`);
  }

  /** Resolve with the next incoming message from a teammate (optionally matching a filter). */
  waitForMessage(timeoutMs, filter = () => true) {
    return new Promise((resolve) => {
      const onMsg = (m) => { if (m.from !== this.me && filter(m)) { cleanup(); resolve(m); } };
      const t = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => { clearTimeout(t); this.off('message', onMsg); };
      this.on('message', onMsg);
    });
  }

  // ---------------- shared permissions (two-party consent)
  /**
   * Policy changes are proposals until every active member has accepted. Stored in room memory under
   * "_policy" and written with optimistic concurrency so simultaneous accepts don't clobber each other.
   */
  async updatePolicy(mutator) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = this.store.policyDoc();
      const next = mutator(structuredClone({ settings: doc.settings || {}, proposal: doc.proposal || null }));
      const active = this.store.members().filter((m) => m.state === 'active').map((m) => m.id);
      if (next.proposal && active.every((id) => next.proposal.acks.includes(id))) {
        next.settings = { ...next.settings, ...next.proposal.settings };
        next.history = [...(doc.history || []).slice(-9), { ...next.proposal, appliedAt: Date.now() }];
        next.proposal = null;
      } else next.history = doc.history || [];
      try {
        await this.remember('_policy', JSON.stringify(next), [], doc.ver);
        return this.store.policyDoc();
      } catch (e) {
        if (e.status !== 409) throw e;
        await this.sync().catch(() => {});
      }
    }
    throw new Error('policy update kept conflicting; try again');
  }
}
