import { execFileSync } from 'node:child_process';
import { basename, relative, isAbsolute, resolve, dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';

const git = (cwd, ...args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim(); }
  catch { return ''; }
};

// git@github.com:linkup/api.git, https://github.com/linkup/api -> github.com/linkup/api
export function normalizeRemote(url) {
  if (!url) return '';
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d)/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const cache = new Map();
/**
 * Identify "the same project" across two laptops: the normalized git remote when there is one
 * (so ~/code/api and ~/work/api-server match), otherwise the folder name.
 */
export function projectInfo(cwd = process.cwd()) {
  if (cache.has(cwd)) return cache.get(cwd);
  const root = git(cwd, 'rev-parse', '--show-toplevel') || cwd;
  const remote = normalizeRemote(git(root, 'config', '--get', 'remote.origin.url'));
  const branch = git(root, 'branch', '--show-current');
  const name = remote ? remote.split('/').pop() : basename(root);
  const info = { id: remote || name, name, root, branch };
  cache.set(cwd, info);
  return info;
}

export const sessionLabel = (p) => (p.branch ? `${p.name}@${p.branch}` : p.name);

/** Path relative to the project root, so teammates' paths line up. */
export function relPath(p, path) {
  if (!path) return path;
  const abs = real(isAbsolute(path) ? path : resolve(p.root, path));
  const rel = relative(real(p.root), abs);
  return rel.startsWith('..') ? abs : rel;
}

// Resolve symlinks (e.g. macOS /var -> /private/var) even for files that don't exist yet.
function real(path) {
  try { return realpathSync(path); }
  catch { const d = dirname(path); return d === path ? path : join(real(d), basename(path)); }
}
