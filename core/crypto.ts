import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const KEY_PATH = path.join(DATA_DIR, 'key');
const ALGORITHM = 'aes-256-gcm';

function loadOrCreateKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    return Buffer.from(readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key.toString('base64'), { mode: 0o600 });
  return key;
}

let _key: Buffer | null = null;
function getKey(): Buffer {
  if (!_key) _key = loadOrCreateKey();
  return _key;
}

/** The on-disk path of the encryption key file, for callers that need to check
 *  its presence without triggering loadOrCreateKey's create-if-missing behavior. */
export const KEY_FILE_PATH = KEY_PATH;

/** True if the key file exists on disk. Does not create one — unlike getKey(),
 *  which lazily generates a key on first use, this is a pure existence check
 *  for health/diagnostic callers (see core/key-health.ts). */
export function keyFileExists(): boolean {
  return existsSync(KEY_PATH);
}

/** Encrypts a plaintext string. Returns a `iv:authTag:ciphertext` base64 triple. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypts a token produced by encryptToken. Plaid tokens never contain ':', so
 *  a value without exactly two colons is treated as a legacy plaintext token. */
export function decryptToken(value: string): string {
  const parts = value.split(':');
  if (parts.length !== 3) return value; // legacy plaintext
  const [ivB64, authTagB64, encB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  return decipher.update(Buffer.from(encB64, 'base64')).toString('utf8') + decipher.final('utf8');
}
