import {
  hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual,
} from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(s, 'base64url');
export const randomId = (bytes = 6) => b64u(randomBytes(bytes));
export const sha256 = (data) => b64u(createHash('sha256').update(data).digest());

/**
 * One shared room secret -> three independent keys.
 *  enc:  AES-256-GCM key for every message/memory/status payload (never leaves clients)
 *  auth: proves knowledge of the secret to the hub when joining (hub stores only sha256(auth))
 *  mem:  HMAC key that turns memory key names into opaque ids so the hub can't read them
 */
export function deriveKeys(secret, roomId) {
  const ikm = fromB64u(secret);
  const k = (info) => Buffer.from(hkdfSync('sha256', ikm, Buffer.from(roomId), Buffer.from(info), 32));
  return { enc: k('agentline/enc/v1'), auth: k('agentline/auth/v1'), mem: k('agentline/mem/v1') };
}

export const verifierFor = (authKey) => sha256(authKey);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// blob = base64url(iv[12] | tag[16] | ciphertext). `aad` binds a blob to its room + purpose.
export function seal(key, obj, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}

export function open(key, blob, aad) {
  const raw = fromB64u(blob);
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

export const memKid = (memKey, name) => b64u(createHmac('sha256', memKey).update(name).digest());

// Invite = hub URL + room id + room secret. Anyone holding it can *request* to join;
// an existing member still has to approve them (unless the room was created with --open).
const INVITE_PREFIX = 'agentline1.';
export function encodeInvite({ hub, room, secret }) {
  return INVITE_PREFIX + b64u(JSON.stringify({ h: hub, r: room, s: secret }));
}
export function decodeInvite(code) {
  const s = String(code).trim();
  if (!s.startsWith(INVITE_PREFIX)) throw new Error('Not an agentline invite (expected "agentline1.…")');
  const { h, r, s: secret } = JSON.parse(fromB64u(s.slice(INVITE_PREFIX.length)).toString('utf8'));
  if (!h || !r || !secret) throw new Error('Malformed invite');
  return { hub: h, room: r, secret };
}
