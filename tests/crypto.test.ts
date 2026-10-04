import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { makeTempDataDir, type TempDataDir } from './helpers/tempFileDb.js';

const ORIGINAL_ENV = process.env.FUNGIBLE_DATA_DIR;
const temps: TempDataDir[] = [];

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env.FUNGIBLE_DATA_DIR;
  else process.env.FUNGIBLE_DATA_DIR = ORIGINAL_ENV;
}

/** Fresh crypto module (key cached per module load) bound to `t`. */
async function loadCrypto(t: TempDataDir) {
  process.env.FUNGIBLE_DATA_DIR = t.dir;
  vi.resetModules();
  try {
    return await import('../core/crypto.js');
  } finally {
    restoreEnv(); // paths.ts has read it; the temp-dir guard dislikes it staying set
  }
}

function tmp() { const t = makeTempDataDir('fungible-crypto-'); temps.push(t); return t; }
const keyPath = (t: TempDataDir) => `${t.dir}/key`;

afterEach(() => { while (temps.length) temps.pop()!.cleanup(); });
afterAll(restoreEnv);

describe('encryptToken / decryptToken', () => {
  it.each([
    ['ascii', 'access-production-abc123'],
    ['unicode', 'tökén-日本語-🔐'],
    ['empty', ''],
  ])('round-trips %s', async (_n, plain) => {
    const c = await loadCrypto(tmp());
    expect(c.decryptToken(c.encryptToken(plain))).toBe(plain);
  });

  it('emits exactly three colon-separated parts and never the plaintext', async () => {
    const c = await loadCrypto(tmp());
    const enc = c.encryptToken('access-production-abc123');
    expect(enc.split(':')).toHaveLength(3);
    expect(enc).not.toContain('abc123');
  });

  it('stores base64 iv:tag:ciphertext with a 12-byte IV and 16-byte auth tag', async () => {
    const c = await loadCrypto(tmp());
    const parts = c.encryptToken('access-production-abc123').split(':');
    for (const p of parts) expect(Buffer.from(p, 'base64').toString('base64')).toBe(p);
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[2], 'base64')).toHaveLength('access-production-abc123'.length);
  });

  it('uses a fresh IV, so equal plaintexts encrypt differently', async () => {
    const c = await loadCrypto(tmp());
    const [a, b] = [c.encryptToken('same'), c.encryptToken('same')];
    expect(a).not.toBe(b);
    expect(a.split(':')[0]).not.toBe(b.split(':')[0]);
  });

  it('returns a legacy plaintext token (no 2 colons) unchanged', async () => {
    const c = await loadCrypto(tmp());
    expect(c.decryptToken('access-sandbox-abc')).toBe('access-sandbox-abc');
  });

  it('throws on a malformed value that has 3 parts but is not valid ciphertext', async () => {
    const c = await loadCrypto(tmp());
    expect(() => c.decryptToken('aaaa:bbbb:cccc')).toThrow();
  });

  it('treats a 2-part value as legacy plaintext, not an error', async () => {
    const c = await loadCrypto(tmp());
    expect(c.decryptToken('only:one-colon')).toBe('only:one-colon');
  });

  it('throws when the ciphertext is tampered with', async () => {
    const c = await loadCrypto(tmp());
    const [iv, tag, data] = c.encryptToken('access-production-abc123').split(':');
    const buf = Buffer.from(data, 'base64');
    buf[0] ^= 0x01;
    expect(() => c.decryptToken(`${iv}:${tag}:${buf.toString('base64')}`)).toThrow();
  });

  it('throws when the auth tag is tampered with', async () => {
    const c = await loadCrypto(tmp());
    const [iv, tag, data] = c.encryptToken('access-production-abc123').split(':');
    const buf = Buffer.from(tag, 'base64');
    buf[0] ^= 0x01;
    expect(() => c.decryptToken(`${iv}:${buf.toString('base64')}:${data}`)).toThrow();
  });
});

describe('key file', () => {
  it('is created lazily on first encrypt with mode 0600; the existence check never creates it', async () => {
    const t = tmp();
    const c = await loadCrypto(t);
    expect(c.keyFileExists()).toBe(false);
    expect(fs.existsSync(keyPath(t))).toBe(false);
    expect(c.keyFileExists()).toBe(false); // asking twice still creates nothing

    c.encryptToken('x');
    expect(c.keyFileExists()).toBe(true);
    expect(fs.statSync(keyPath(t)).mode & 0o777).toBe(0o600);
    expect(c.KEY_FILE_PATH).toBe(keyPath(t));
  });

  it('is reused across module reloads, so old ciphertext still decrypts', async () => {
    const t = tmp();
    const enc = (await loadCrypto(t)).encryptToken('access-production-abc123');
    const keyBefore = fs.readFileSync(keyPath(t), 'utf8');
    const again = await loadCrypto(t);
    expect(again.decryptToken(enc)).toBe('access-production-abc123');
    expect(fs.readFileSync(keyPath(t), 'utf8')).toBe(keyBefore);
  });

  it('a lost key file means old tokens fail loudly rather than decrypting to garbage', async () => {
    const t = tmp();
    const enc = (await loadCrypto(t)).encryptToken('access-production-abc123');
    fs.rmSync(keyPath(t));
    const fresh = await loadCrypto(t); // generates a different key
    expect(() => fresh.decryptToken(enc)).toThrow();
  });
});
