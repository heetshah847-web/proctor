import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, run } from './db.js';
import { config } from './config.js';

const SESSION_DAYS = 14;
const scrypt = promisify(crypto.scrypt);
const cookieAttrs = `HttpOnly; SameSite=Lax; Path=/${config.secureCookies ? '; Secure' : ''}`;

// Async scrypt runs on the libuv thread pool, so a flood of logins can't freeze the event loop.
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(pw, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

// A valid hash used when the email is unknown, so "no such user" takes as long as "wrong password".
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

export async function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || DUMMY_HASH).split(':');
  const test = await scrypt(pw, salt, 64);
  const ok = crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
  return Boolean(stored) && ok;
}

export function newInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}`);
}

export function destroySession(req, res) {
  const token = readCookie(req, 'sid');
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `sid=; ${cookieAttrs}; Max-Age=0`);
}

/** Deletes expired sessions. Called at startup and hourly. */
export const purgeExpiredSessions = () => run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try { return decodeURIComponent(v.join('=')); } catch { return null; } // malformed cookie = not signed in
  }
  return null;
}

export function loadUser(req, _res, next) {
  const token = readCookie(req, 'sid');
  if (token) {
    const row = one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      token, Date.now(),
    );
    if (row) req.user = row;
  }
  next();
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, role: u.role, name: u.name, email: u.email,
    inviteCode: u.role === 'supervisor' ? u.invite_code : undefined,
    supervisorId: u.supervisor_id ?? null,
    leetcodeUsername: u.leetcode_username ?? null,
    tufConnected: Boolean(u.tuf_cookie),
  };
}
