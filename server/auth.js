import crypto from 'node:crypto';
import { one, run } from './db.js';

const SESSION_DAYS = 14;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

export function newInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

export function destroySession(req, res) {
  const token = readCookie(req, 'sid');
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
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
