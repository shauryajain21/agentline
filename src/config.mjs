import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = () => process.env.AGENTLINE_HOME || join(homedir(), '.agentline');
const file = () => join(home(), 'config.json');

export function loadConfig() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); }
  catch { return { default: null, rooms: {} }; }
}

export function saveConfig(cfg) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, file());
  chmodSync(file(), 0o600);
}

/** Resolve a room by explicit id/alias, then $AGENTLINE_ROOM, then the default. */
export function getRoom(which = process.env.AGENTLINE_ROOM) {
  const cfg = loadConfig();
  const key = which || cfg.default;
  const room = cfg.rooms[key] || Object.values(cfg.rooms).find((r) => r.alias === key);
  if (!room) {
    const known = Object.values(cfg.rooms).map((r) => r.alias || r.room).join(', ') || 'none';
    throw new Error(`No agentline room "${key ?? '(default)'}". Known rooms: ${known}. Run \`agentline init\` or \`agentline join\`.`);
  }
  return room;
}

export function putRoom(room, makeDefault = true) {
  const cfg = loadConfig();
  cfg.rooms[room.room] = room;
  if (makeDefault || !cfg.default) cfg.default = room.room;
  saveConfig(cfg);
}

export function roomDir(roomId) {
  const d = join(home(), 'rooms', roomId);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
