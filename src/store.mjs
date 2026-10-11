// Local, decrypted replica of a room. The MCP server keeps it live over a WebSocket; hooks and the
// CLI read it directly (a few ms) instead of going over the network. WAL mode makes the
// one-writer/many-readers pattern across processes safe.
import { join } from 'node:path';
import { openDb } from './sqlite.mjs';
import { roomDir } from './config.mjs';

export const DEFAULT_POLICY = { autonomy: 'ask', worklogs: true, overlap: true };

export class Store {
  constructor(roomId) {
    this.db = openDb(join(roomDir(roomId), 'local.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY, sender TEXT, recipient TEXT, ts INT,
        kind TEXT, project TEXT, body TEXT, read INT NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS messages_unread ON messages(read, seq);
      CREATE TABLE IF NOT EXISTS memory(kid TEXT PRIMARY KEY, key TEXT, value TEXT, tags TEXT, author TEXT,
        ts INT, ver INT, deleted INT NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, name TEXT, state TEXT, role TEXT, online INT,
        last_seen INT, status TEXT, status_ts INT);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS activity(session TEXT, project TEXT, path TEXT, tool TEXT, ts INT, edits INT,
        PRIMARY KEY(session, path));
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      insMsg: p(`INSERT OR IGNORE INTO messages(seq,sender,recipient,ts,kind,project,body,read) VALUES(?,?,?,?,?,?,?,?)`),
      msg: p('SELECT * FROM messages WHERE seq=?'),
      unread: p(`SELECT * FROM messages WHERE read=0 AND sender!=? ORDER BY seq LIMIT ?`),
      markRead: p('UPDATE messages SET read=1 WHERE seq<=? AND read=0 AND sender!=?'),
      markOne: p('UPDATE messages SET read=1 WHERE seq=?'),
      recent: p('SELECT * FROM messages ORDER BY seq DESC LIMIT ?'),
      byKind: p('SELECT * FROM messages WHERE kind=? AND ts>=? ORDER BY seq DESC LIMIT ?'),
      replies: p("SELECT * FROM messages WHERE json_extract(body,'$.thread')=? ORDER BY seq"),
      mem: p('SELECT * FROM memory WHERE kid=?'),
      memAll: p('SELECT * FROM memory WHERE deleted=0 ORDER BY ts DESC'),
      upMem: p(`INSERT INTO memory(kid,key,value,tags,author,ts,ver,deleted) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(kid) DO UPDATE SET key=excluded.key, value=excluded.value, tags=excluded.tags,
        author=excluded.author, ts=excluded.ts, ver=excluded.ver, deleted=excluded.deleted WHERE excluded.ver > memory.ver`),
      upMember: p(`INSERT INTO members(id,name,state,role,online,last_seen,status,status_ts) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, state=excluded.state, role=excluded.role,
        online=excluded.online, last_seen=excluded.last_seen,
        status=COALESCE(excluded.status, members.status), status_ts=COALESCE(excluded.status_ts, members.status_ts)`),
      members: p('SELECT * FROM members ORDER BY name'),
      member: p('SELECT * FROM members WHERE id=?'),
      presence: p('UPDATE members SET online=?, last_seen=? WHERE id=?'),
      status: p('UPDATE members SET status=?, status_ts=? WHERE id=?'),
      get: p('SELECT v FROM kv WHERE k=?'),
      set: p('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
      touch: p(`INSERT INTO activity(session,project,path,tool,ts,edits) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session,path) DO UPDATE SET tool=excluded.tool, ts=excluded.ts, edits=activity.edits+excluded.edits`),
      sessionFiles: p('SELECT * FROM activity WHERE session=? AND edits>0 ORDER BY ts DESC'),
      sessionEdits: p('SELECT COALESCE(SUM(edits),0) n FROM activity WHERE session=?'),
      pruneActivity: p('DELETE FROM activity WHERE ts<?'),
    };
  }

  close() { this.db.close(); }

  // ---- kv
  get(k, dflt = null) { const r = this.q.get.get(k); return r ? JSON.parse(r.v) : dflt; }
  set(k, v) { this.q.set.run(k, JSON.stringify(v)); }

  // ---- messages
  addMessage({ seq, from, to, ts, body }, read = false) {
    this.q.insMsg.run(seq, from, to ?? null, ts, body.kind || 'chat', body.session?.project ?? null, JSON.stringify(body), read ? 1 : 0);
  }
  message(seq) { return hydrate(this.q.msg.get(seq)); }
  unread(me, limit = 50) { return this.q.unread.all(me, limit).map(hydrate); }
  markRead(me, uptoSeq) { this.q.markRead.run(uptoSeq, me); }
  markOne(seq) { this.q.markOne.run(seq); }
  recent(limit = 50) { return this.q.recent.all(limit).map(hydrate).reverse(); }
  byKind(kind, sinceTs = 0, limit = 50) { return this.q.byKind.all(kind, sinceTs, limit).map(hydrate); }
  replies(seq) { return this.q.replies.all(seq).map(hydrate); }

  // ---- memory
  putMemory({ kid, key, value, tags, author, ts, ver, deleted }) {
    this.q.upMem.run(kid, key ?? null, value ?? null, tags ? JSON.stringify(tags) : null, author, ts, ver, deleted ? 1 : 0);
  }
  memory(kid) { const r = this.q.mem.get(kid); return r && !r.deleted ? memRow(r) : null; }
  memoryRaw(kid) { return this.q.mem.get(kid); }
  memories() { return this.q.memAll.all().map(memRow).filter((m) => !m.key.startsWith('_')); }

  /** The shared permissions document lives in room memory under "_policy" (see permissions tool). */
  policyDoc() {
    const r = this.db.prepare("SELECT * FROM memory WHERE key='_policy' AND deleted=0").get();
    return r ? { ver: r.ver, ...JSON.parse(r.value) } : { ver: 0, settings: {}, proposal: null };
  }
  policy() { return { ...DEFAULT_POLICY, ...(this.policyDoc().settings || {}) }; }

  // ---- members
  putMember(m) {
    this.q.upMember.run(m.id, m.name, m.state, m.role, m.online ? 1 : 0, m.lastSeen ?? null, m.status ?? null, m.statusTs ?? null);
  }
  members() { return this.q.members.all().map((m) => ({ ...m, status: m.status ? JSON.parse(m.status) : null, online: !!m.online })); }
  member(id) { const m = this.q.member.get(id); return m && { ...m, status: m.status ? JSON.parse(m.status) : null }; }
  presence(id, online) { this.q.presence.run(online ? 1 : 0, Date.now(), id); }
  status(id, status, ts) { this.q.status.run(JSON.stringify(status), ts, id); }
  name(id) { return this.q.member.get(id)?.name || id; }

  // ---- session activity (fed by the PostToolUse hook)
  touch(session, project, path, tool, edit) {
    this.q.touch.run(session, project, path, tool, Date.now(), edit ? 1 : 0);
  }
  sessionFiles(session) { return this.q.sessionFiles.all(session); }
  sessionEdits(session) { return this.q.sessionEdits.get(session).n; }
  /** Files edited in a project since `sinceTs`, newest first (all local sessions). */
  projectEdits(project, sinceTs = 0) {
    return this.db.prepare(`SELECT path, MAX(ts) ts, SUM(edits) edits FROM activity
      WHERE project=? AND edits>0 AND ts>? GROUP BY path ORDER BY ts DESC`).all(project, sinceTs);
  }
  prune() { this.q.pruneActivity.run(Date.now() - 7 * 864e5); }

  /** Lightweight relevance search across teammates' messages, worklogs and shared memory. */
  search(query, { project = null, limit = 10, kinds = null, sinceTs = 0 } = {}) {
    const terms = tokenize(query);
    const scored = [];
    const score = (text, boost = 1) => {
      if (!terms.length) return boost;
      const hay = text.toLowerCase();
      let s = 0;
      for (const t of terms) if (hay.includes(t)) s += t.length > 3 ? 2 : 1;
      return s * boost;
    };
    for (const m of this.db.prepare('SELECT * FROM messages WHERE ts>=? ORDER BY seq DESC LIMIT 2000').all(sinceTs)) {
      if (kinds && !kinds.includes(m.kind)) continue;
      const body = JSON.parse(m.body);
      const text = [body.text, body.worklog?.summary, body.worklog?.next, ...(body.worklog?.files || []),
        ...(body.attachments || []).map((a) => `${a.path || ''} ${a.title || ''}`)].filter(Boolean).join(' ');
      let s = score(text, m.kind === 'worklog' ? 1.5 : 1);
      if (project && m.project === project) s += terms.length ? 1 : 2;
      if (s > 0) scored.push({ s: s + recency(m.ts), type: 'msg', item: hydrate(m) });
    }
    if (!kinds || kinds.includes('memory')) {
      for (const r of this.memories()) {
        const s = score(`${r.key} ${r.value} ${(r.tags || []).join(' ')}`, 1.5);
        if (s > 0) scored.push({ s: s + recency(r.ts), type: 'mem', item: r });
      }
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, limit);
  }
}

const recency = (ts) => Math.max(0, 1 - (Date.now() - ts) / (14 * 864e5)); // ≤ +1 for the last two weeks
const tokenize = (q) => String(q || '').toLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((t) => t.length > 1);
const hydrate = (r) => r && {
  seq: r.seq, from: r.sender, to: r.recipient, ts: r.ts, kind: r.kind, project: r.project, body: JSON.parse(r.body), read: !!r.read,
};
const memRow = (r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [], deleted: !!r.deleted });
