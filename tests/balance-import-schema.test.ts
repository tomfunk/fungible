import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The production schema (autoincrement id + unique index) differs from the
// test helper schema (composite PK); the upsert must work on both.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bal-import-'));
process.env.FUNGIBLE_DATA_DIR = dir;

describe('balance import on the production schema', () => {
  it('upserts against the real initDb schema', async () => {
    const { db, initDb } = await import('../core/db.js');
    await initDb();
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('a', 'Checking', 'depository')");
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('a', 9, '2026-05-20')");
    const { commitBalanceImport } = await import('../core/balance-import.js');
    const csv = 'date,account,balance\n2026-01-01,Checking,1\n';
    await commitBalanceImport(csv, { today: '2026-06-01' });
    const r2 = await commitBalanceImport('date,account,balance\n2026-01-01,Checking,2\n', { today: '2026-06-01' });
    expect(r2.overwritten).toBe(1);
    const rows = (await db.execute("SELECT balance FROM balance_history WHERE account_id='a' AND date='2026-01-01'")).rows;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].balance)).toBe(2);
    vi.resetModules();
  });
});
