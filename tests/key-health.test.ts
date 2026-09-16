import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

const cryptoMock = vi.hoisted(() => ({
  keyFileExists: vi.fn(() => true),
  decryptToken: vi.fn((t: string) => t),
}));
vi.mock('../core/crypto.js', () => cryptoMock);

import { db } from '../core/db.js';
import { checkKeyHealth } from '../core/key-health.js';

async function insertLinkedAccount(accountId: string, itemId: string, accessToken = 'enc(tok)') {
  await db.execute({
    sql: `INSERT OR IGNORE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`,
    args: [itemId, accessToken, 'Tartan Bank'],
  });
  await db.execute({
    sql: `INSERT INTO accounts (id, name, type, item_id) VALUES (?, ?, ?, ?)`,
    args: [accountId, 'Checking', 'depository', itemId],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  cryptoMock.keyFileExists.mockReturnValue(true);
  cryptoMock.decryptToken.mockImplementation((t: string) => t);
  await db.execute('DELETE FROM accounts');
  await db.execute('DELETE FROM plaid_items');
});

describe('checkKeyHealth', () => {
  it('is ok with no linked accounts, without checking the key at all', async () => {
    const result = await checkKeyHealth();
    expect(result).toEqual({ ok: true });
    expect(cryptoMock.keyFileExists).not.toHaveBeenCalled();
  });

  it('is ok when the key file exists and decrypts a stored token', async () => {
    await insertLinkedAccount('acct-1', 'item-1');

    const result = await checkKeyHealth();

    expect(result).toEqual({ ok: true });
  });

  it('reports missing_key when linked accounts exist but the key file is gone', async () => {
    await insertLinkedAccount('acct-1', 'item-1');
    cryptoMock.keyFileExists.mockReturnValue(false);

    const result = await checkKeyHealth();

    expect(result).toEqual({ ok: false, reason: 'missing_key', linkedAccountCount: 1 });
    expect(cryptoMock.decryptToken).not.toHaveBeenCalled();
  });

  it('reports decrypt_failed when the key file exists but does not decrypt the stored token', async () => {
    await insertLinkedAccount('acct-1', 'item-1');
    cryptoMock.decryptToken.mockImplementation(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });

    const result = await checkKeyHealth();

    expect(result).toEqual({ ok: false, reason: 'decrypt_failed', linkedAccountCount: 1 });
  });

  it('counts multiple linked accounts', async () => {
    await insertLinkedAccount('acct-1', 'item-1');
    await insertLinkedAccount('acct-2', 'item-1');
    await insertLinkedAccount('acct-3', 'item-2');
    cryptoMock.keyFileExists.mockReturnValue(false);

    const result = await checkKeyHealth();

    expect(result).toEqual({ ok: false, reason: 'missing_key', linkedAccountCount: 3 });
  });
});
