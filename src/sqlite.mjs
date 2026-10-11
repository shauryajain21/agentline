// node:sqlite is stable enough for our use but still prints an ExperimentalWarning,
// which would pollute hook output and CLI UX. Filter just that one warning.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && msg.includes('SQLite')) return;
  return emit.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
  return db;
}
export { DatabaseSync };
