import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { seedTx } from './helpers/seedDb.js';
import { getTransactionDetail } from '../core/transaction-detail.js';

async function seedAccount(id: string, o: { name?: string; nickname?: string | null; mask?: string | null; itemId?: string | null } = {}) {
  await db.execute({
    sql: 'INSERT INTO accounts (id, name, type, mask, nickname, item_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, o.name ?? 'Checking', 'depository', o.mask ?? null, o.nickname ?? null, o.itemId ?? null],
  });
}

describe('getTransactionDetail', () => {
  it('returns account, mask and institution for a plaid row', async () => {
    await db.execute({ sql: `INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item-1', 'x', 'Chase')` });
    await seedAccount('a-plaid', { name: 'Total Checking', nickname: 'Daily', mask: '1234', itemId: 'item-1' });
    const tx = await seedTx(db, {
      account_id: 'a-plaid', name: 'SQ *COFFEE 123', merchant_name: 'Coffee', display_name: 'Coffee Shop',
      pending: true, source: 'plaid',
    });
    expect(await getTransactionDetail(tx.id)).toEqual({
      id: tx.id, accountName: 'Daily', accountMask: '1234', institution: 'Chase',
      name: 'SQ *COFFEE 123', merchantName: 'Coffee', displayName: 'Coffee Shop',
      pending: true, source: 'plaid', importFile: null, importedAt: null,
    });
  });

  it('falls back to the account name when there is no nickname', async () => {
    await seedAccount('a-nonick', { name: 'Savings' });
    const tx = await seedTx(db, { account_id: 'a-nonick' });
    expect((await getTransactionDetail(tx.id))?.accountName).toBe('Savings');
  });

  it('returns import file and ISO timestamp for a csv row; null mask/institution', async () => {
    await seedAccount('a-csv', { name: 'Card' });
    const ms = Date.UTC(2026, 2, 5, 10, 30, 0);
    const imp = await db.execute({
      sql: `INSERT INTO imports (account_id, file_name, file_hash, imported_at, row_count, config) VALUES ('a-csv', 'march.csv', 'h', ?, 1, '{}')`,
      args: [ms],
    });
    const tx = await seedTx(db, { account_id: 'a-csv', source: 'csv', import_id: Number(imp.lastInsertRowid) });
    const d = await getTransactionDetail(tx.id);
    expect(d).toMatchObject({
      source: 'csv', importFile: 'march.csv', importedAt: '2026-03-05T10:30:00.000Z',
      accountMask: null, institution: null, pending: false, merchantName: null, displayName: null,
    });
  });

  it('manual row has no import info', async () => {
    await seedAccount('a-man', { name: 'Cash' });
    const tx = await seedTx(db, { account_id: 'a-man', source: 'manual' });
    expect(await getTransactionDetail(tx.id)).toMatchObject({ source: 'manual', importFile: null, importedAt: null });
  });

  it('returns null for an unknown id', async () => {
    expect(await getTransactionDetail('nope')).toBeNull();
  });
});
