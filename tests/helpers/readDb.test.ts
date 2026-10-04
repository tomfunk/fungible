import { describe, it, expect } from 'vitest';
import { makeTestDb } from './makeTestDb.js';
import { seedTx } from './seedDb.js';
import { readTx, readTxTags, readAccount, countRows } from './readDb.js';

describe('readDb', () => {
  it('readTx returns the full row or null', async () => {
    const db = await makeTestDb();
    const t = await seedTx(db, { amount: -5 });
    const row = await readTx(db, t.id as string);
    expect(row).toMatchObject({ id: t.id, amount: -5 });
    expect(Array.isArray(row)).toBe(false);
    expect(await readTx(db, 'nope')).toBeNull();
  });

  it('readTxTags returns sorted names; empty when none', async () => {
    const db = await makeTestDb();
    const t = await seedTx(db);
    expect(await readTxTags(db, t.id as string)).toEqual([]);
    await db.execute("INSERT INTO tags (name) VALUES ('zeta'), ('alpha')");
    await db.execute({ sql: 'INSERT INTO transaction_tags SELECT ?, id FROM tags', args: [t.id as string] });
    expect(await readTxTags(db, t.id as string)).toEqual(['alpha', 'zeta']);
  });

  it('readAccount and countRows', async () => {
    const db = await makeTestDb();
    const t = await seedTx(db);
    expect(await readAccount(db, 'missing')).toBeNull();
    await db.execute("INSERT INTO accounts (id, name, type, nickname) VALUES ('a1', 'Chk', 'depository', 'Main')");
    expect(await readAccount(db, 'a1')).toMatchObject({ id: 'a1', name: 'Chk', nickname: 'Main', excluded: 0 });
    expect(await countRows(db, 'transactions')).toBe(1);
    expect(await countRows(db, 'transactions', 'id = ?', [t.id as string])).toBe(1);
    expect(await countRows(db, 'transactions', 'id = ?', ['x'])).toBe(0);
  });
});
