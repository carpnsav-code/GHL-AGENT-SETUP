// Passwords and long-lived sessions, built on node:crypto only.
//
// Password hashing: scrypt with a per-user random salt, stored as
//   scrypt$<N>$<salt-b64url>$<hash-b64url>
// Sessions: a random 256-bit token is handed to the browser (cookie + body);
// only its SHA-256 is stored, so a database leak does not leak live logins.

import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import * as store from './db.js';

const scryptAsync = promisify(scrypt);
const SCRYPT_N = 16384;
const KEY_LEN = 64;

export const SESSION_COOKIE = 'mc_session';
/** How long a login lasts without use. Activity extends it, so a crew member
 *  who opens the app at least this often never has to log in again. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, nStr, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(nStr),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, userAgent) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  store.insertSession(db, { tokenHash: hashToken(token), userId, expiresAt, userAgent });
  return { token, expiresAt };
}

/** Resolve a token to its user, extending the session if it has been a day. */
export function resolveSession(db, token) {
  if (!token) return null;
  const session = store.findSession(db, hashToken(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    store.deleteSession(db, session.token_hash);
    return null;
  }
  const user = store.findUserById(db, session.user_id);
  if (!user) return null;
  if (Date.now() - new Date(session.last_seen_at).getTime() > SLIDE_AFTER_MS) {
    store.touchSession(db, session.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  }
  return user;
}

export function destroySession(db, token) {
  if (token) store.deleteSession(db, hashToken(token));
}

// ---------------------------------------------------------------------------
// HTTP helpers

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The session token from the cookie, or from `Authorization: Bearer`
 *  (used by the installed app as a fallback when cookies are unavailable). */
export function tokenFromRequest(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function isSecureRequest(req) {
  if (process.env.MC_SECURE_COOKIES === '1') return true;
  if (process.env.MC_SECURE_COOKIES === '0') return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

export function sessionCookie(req, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}
