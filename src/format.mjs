// Token-frugal renderings shared by the MCP tools, hooks and CLI.
export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

export function attachmentLabel(a) {
  const where = a.path ? `${a.path}${a.lines ? `:${a.lines}` : ''}` : a.title || a.type;
  const size = a.content ? `${a.content.split('\n').length} lines` : '';
  return `[${a.type} ${where}${size ? `, ${size}` : ''}${a.truncated ? ', truncated' : ''}]`;
}

/** One message -> compact text. `inlineBudget` bounds how much attachment content is inlined. */
export function fmtMsg(store, m, me, { full = false, textMax = 600, inlineBudget = 0 } = {}) {
  const b = m.body;
  const who = m.from === me ? 'you' : store.name(m.from);
  const to = m.to ? (m.to === me ? ' → you' : ` → ${store.name(m.to)}`) : '';
  const via = b.session ? ` (${b.session.via === 'human' ? 'human' : 'agent'}, ${b.session.label})` : '';
  const kind = b.kind && b.kind !== 'chat' ? ` · ${b.kind}${b.urgent ? '!' : ''}` : b.urgent ? ' · urgent' : '';
  const thread = b.thread ? ` · re #${b.thread}` : '';
  let out = `#${m.seq} ${who}${via}${to}${kind}${thread} · ${ago(m.ts)}`;
  if (b.worklog) {
    const w = b.worklog;
    out += `\n  did: ${full ? w.summary : clip(w.summary, textMax)}`;
    if (w.files?.length) out += `\n  files: ${w.files.slice(0, full ? 100 : 12).join(', ')}${!full && w.files.length > 12 ? ` +${w.files.length - 12}` : ''}`;
    if (w.next) out += `\n  next: ${full ? w.next : clip(w.next, 300)}`;
  }
  if (b.text) out += `\n  ${(full ? b.text : clip(b.text, textMax)).replace(/\n/g, '\n  ')}`;
  for (const a of b.attachments || []) {
    const fits = a.content && (full || a.content.length <= inlineBudget);
    out += `\n  ${attachmentLabel(a)}`;
    if (fits) { out += `\n\`\`\`${a.lang || ''}\n${a.content}\n\`\`\``; inlineBudget -= a.content.length; }
    else if (a.content) out += ` → read(${m.seq}) for content`;
  }
  return out;
}

export function fmtMember(m, me) {
  const st = m.status ? ` — ${clip(m.status.text, 160)} [${m.status.label}${m.statusTs || m.status_ts ? `, ${ago(m.status_ts || m.statusTs)}` : ''}]` : '';
  const pres = m.state !== 'active' ? m.state : m.online ? 'online' : `offline${m.last_seen ? `, seen ${ago(m.last_seen)}` : ''}`;
  return `${m.name}${m.id === me ? ' (you)' : ''}: ${pres}${st}`;
}

export function fmtPolicy(p) {
  return `autonomy=${p.autonomy} (${p.autonomy === 'auto' ? 'agents share proactively, then tell their human' : 'agents ask their human before sharing'}), worklogs=${p.worklogs ? 'on' : 'off'}, overlap-alerts=${p.overlap ? 'on' : 'off'}`;
}

export const LANG = { js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', md: 'md', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash',
  sql: 'sql', css: 'css', html: 'html', c: 'c', h: 'c', cpp: 'cpp', toml: 'toml' };
export const langOf = (path) => LANG[String(path).split('.').pop().toLowerCase()] || '';
