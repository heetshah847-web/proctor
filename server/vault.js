// Encryption for sensitive values stored in the database (AES-256-GCM) and one-way hashing for tokens.
// The key comes from DATA_ENCRYPTION_KEY (64 hex chars). Without it, a key is generated once into
// data/encryption.key. In production put the key in the environment and keep it out of DB backups:
// a stolen database is then useless without the key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const PREFIX = 'enc1:';

function loadKey() {
  const fromEnv = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    return Buffer.from(fromEnv, 'hex');
  }
  const file = path.join(ROOT, 'data', 'encryption.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    console.warn(`Generated a data encryption key in ${file}. For production, move it to DATA_ENCRYPTION_KEY and back it up separately — losing it makes encrypted fields unreadable.`);
  }
  if (process.env.NODE_ENV === 'production') console.warn('DATA_ENCRYPTION_KEY is not set; using data/encryption.key (stored next to the database).');
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/** Encrypts a string. null/empty stays null. */
export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Decrypts a value from encrypt(). Returns null if it can't be decrypted (wrong key / tampered). */
export function decrypt(stored) {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored; // legacy plaintext (migrated at startup)
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    console.error('Could not decrypt a stored value (wrong DATA_ENCRYPTION_KEY?)');
    return null;
  }
}

/** One-way hash for bearer tokens (sessions): the DB stores only this, never the token itself. */
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
