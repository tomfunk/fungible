import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { dedupKey } from '../core/csv.js';

/**
 * The only test that runs against a real on-disk database.
 *
 * initDb's job is to bring an *existing* database forward, and every other test
 * builds the current schema directly via tests/helpers/makeTestDb — so without
 * this file the migration path has no coverage at all, which is uncomfortable
 * for the one piece of code that touches user data it did not create.
 *
 * core/paths.ts resolves DATA_DIR from the environment at module load, so the
 * db module is imported dynamically after FUNGIBLE_DATA_DIR is pointed at a
 * temporary directory.
 */

// The transactions table as it stood before this change: every earlier column
// migration applied, none of the provenance ones.
const OLD_SCHEMA = [
  `CREATE TABLE accounts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, subtype TEXT,
    institution_name TEXT, mask TEXT
  )`,
  `CREATE TABLE transactions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL,
    merchant_name TEXT, amount REAL NOT NULL, category TEXT, raw_category TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    manual_category TEXT, display_name TEXT, ignored INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  )`,
];

// Old-style rows. The CSV ids are the hash form the retired generateTxId
// produced; the Plaid id is opaque, as Plaid's transaction ids are.
const OLD_ROWS: [string, string, string, string, number][] = [
  ['csv-aaaa1111bbbb2222', 'chase', '2025-01-02', 'AMAZON',  25.00],
  ['csv-cccc3333dddd4444', 'chase', '2025-01-05', 'NETFLIX', 15.00],
  // Same account, same date, same name, same amount, different ids — the shape
  // that would violate the new unique index if the backfill assigned every row
  // the same ordinal.
  ['csv-eeee5555ffff6666', 'chase', '2025-01-09', 'COFFEE',   4.50],
  ['csv-7777888899990000', 'chase', '2025-01-09', 'COFFEE',   4.50],
  // Deliberately identical in content to the AMAZON row above: a Plaid row must
  // not be given a dedup_key, or the two would collide inside one account.
  ['A1b2C3d4E5f6G7h8',     'chase', '2025-01-02', 'AMAZON',  25.00],
];

// A second, CSV-only account for the balance_history backfill (#200): kept
// separate from 'chase' above so its balance isn't muddied by chase's mix of
// csv and plaid rows. Depository (asset), so the expected balance is
// -SUM(amount): the paycheck (amount < 0, an inflow) adds 1200, the grocery
// charge (amount > 0, an outflow) subtracts 200, net 1000.
const ALLY_ROWS: [string, string, string, number][] = [
  ['csv-ally00000000001', '2025-01-10', 'PAYCHECK',  -1200.00],
  ['csv-ally00000000002', '2025-01-12', 'GROCERIES',   200.00],
];

let dir: string;
let db: Client;

async function column(id: string, name: string): Promise<string | null> {
  const r = await db.execute({ sql: `SELECT ${name} as v FROM transactions WHERE id = ?`, args: [id] });
  const v = (r.rows[0] as unknown as { v: string | null } | undefined)?.v;
  return v ?? null;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-migration-'));
  process.env.FUNGIBLE_DATA_DIR = dir;

  const mod = await import('../core/db.js');
  db = mod.db;

  for (const stmt of OLD_SCHEMA) await db.execute(stmt);
  await db.execute("INSERT INTO accounts (id, name, type) VALUES ('chase', 'Chase', 'credit')");
  for (const [id, account, date, name, amount] of OLD_ROWS) {
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
            VALUES (?, ?, ?, ?, ?, 'Uncategorized', 0, 0)`,
      args: [id, account, date, name, amount],
    });
  }

  await db.execute("INSERT INTO accounts (id, name, type) VALUES ('ally', 'Ally', 'depository')");
  for (const [id, date, name, amount] of ALLY_ROWS) {
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
            VALUES (?, 'ally', ?, ?, ?, 'Uncategorized', 0, 0)`,
      args: [id, date, name, amount],
    });
  }

  await mod.initDb();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FUNGIBLE_DATA_DIR;
});

describe('initDb provenance migration', () => {
  it('adds the columns, the imports table and the unique index', async () => {
    const cols = (await db.execute('PRAGMA table_info(transactions)')).rows as unknown as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['source', 'import_id', 'dedup_key']));

    const objects = (await db.execute(
      "SELECT name FROM sqlite_master WHERE name IN ('imports','idx_transactions_dedup','idx_transactions_import')",
    )).rows as unknown as { name: string }[];
    expect(objects.map((o) => o.name).sort())
      .toEqual(['idx_transactions_dedup', 'idx_transactions_import', 'imports']);
  });

  it('labels rows by provenance, reading the id prefix exactly once', async () => {
    expect(await column('csv-aaaa1111bbbb2222', 'source')).toBe('csv');
    expect(await column('csv-cccc3333dddd4444', 'source')).toBe('csv');
    expect(await column('A1b2C3d4E5f6G7h8', 'source')).toBe('plaid');
  });

  it('rewrites no ids', async () => {
    const ids = (await db.execute("SELECT id FROM transactions WHERE account_id = 'chase' ORDER BY rowid"))
      .rows as unknown as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(OLD_ROWS.map(([id]) => id));
  });

  it('leaves legacy rows without an import, since no file is recorded for them', async () => {
    const orphaned = await db.execute("SELECT COUNT(*) as n FROM transactions WHERE import_id IS NOT NULL");
    expect(Number((orphaned.rows[0] as unknown as { n: number }).n)).toBe(0);
    expect((await db.execute('SELECT * FROM imports')).rows).toHaveLength(0);
  });

  it('gives CSV rows the key a re-import of the same statement would compute', async () => {
    expect(await column('csv-aaaa1111bbbb2222', 'dedup_key')).toBe(dedupKey('2025-01-02', 'AMAZON', 25, 0));
    expect(await column('csv-cccc3333dddd4444', 'dedup_key')).toBe(dedupKey('2025-01-05', 'NETFLIX', 15, 0));
  });

  it('leaves Plaid rows unkeyed, so they never collide with a CSV row', async () => {
    expect(await column('A1b2C3d4E5f6G7h8', 'dedup_key')).toBeNull();
  });

  // Assigning ordinals by construction is what makes the backfill incapable of
  // violating the index it creates immediately afterwards.
  it('separates pre-existing identical rows by ordinal instead of failing', async () => {
    expect(await column('csv-eeee5555ffff6666', 'dedup_key')).toBe(dedupKey('2025-01-09', 'COFFEE', 4.5, 0));
    expect(await column('csv-7777888899990000', 'dedup_key')).toBe(dedupKey('2025-01-09', 'COFFEE', 4.5, 1));
  });

  it('protects the backfilled rows from being imported a second time', async () => {
    await expect(db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, pending, ignored, source, dedup_key)
            VALUES ('csv-9-0', 'chase', '2025-01-02', 'AMAZON', 25.00, 0, 0, 'csv', ?)`,
      args: [dedupKey('2025-01-02', 'AMAZON', 25, 0)],
    })).rejects.toThrow(/UNIQUE/i);
  });

  it('is idempotent — a second launch changes nothing', async () => {
    const before = (await db.execute('SELECT id, source, dedup_key, import_id FROM transactions ORDER BY rowid')).rows;
    const { initDb } = await import('../core/db.js');
    await expect(initDb()).resolves.not.toThrow();
    const after = (await db.execute('SELECT id, source, dedup_key, import_id FROM transactions ORDER BY rowid')).rows;
    expect(after).toEqual(before);
  });
});

// #200: a CSV-imported account that predates the importCsvTransactions fix has
// transactions but no balance_history row at all, which silently drops it out
// of every net-worth/health query (they inner-join on MAX(date)). initDb
// backfills one computed row per such account, the same way a fresh import
// would from now on.
describe('initDb balance_history backfill (#200)', () => {
  it('gives a pre-existing CSV-only account a computed balance row', async () => {
    const rows = (await db.execute({
      sql: 'SELECT balance, date FROM balance_history WHERE account_id = ?', args: ['ally'],
    })).rows as unknown as { balance: number; date: string }[];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].balance)).toBeCloseTo(1000, 5);
  });

  it('is idempotent — a second launch does not add or change the row', async () => {
    const before = (await db.execute({
      sql: 'SELECT balance, date FROM balance_history WHERE account_id = ?', args: ['ally'],
    })).rows;
    const { initDb } = await import('../core/db.js');
    await expect(initDb()).resolves.not.toThrow();
    const after = (await db.execute({
      sql: 'SELECT balance, date FROM balance_history WHERE account_id = ?', args: ['ally'],
    })).rows;
    expect(after).toEqual(before);
  });

  it('leaves an account that already has a balance_history row alone', async () => {
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('seeded', 'Seeded', 'depository')");
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
            VALUES ('csv-seeded00000001', 'seeded', '2025-01-01', 'X', 999, 'Uncategorized', 0, 0)`,
    });
    await db.execute({
      sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('seeded', 42, '2020-01-01')",
    });
    const { initDb } = await import('../core/db.js');
    await initDb();
    const rows = (await db.execute({
      sql: 'SELECT balance, date FROM balance_history WHERE account_id = ?', args: ['seeded'],
    })).rows as unknown as { balance: number; date: string }[];
    expect(rows).toEqual([{ balance: 42, date: '2020-01-01' }]);
  });
});

// Widens transactions.source to allow 'manual' (hand-entered rows). SQLite
// can't ALTER a CHECK constraint, so initDb rebuilds the table instead — this
// covers that every plaid/csv/manual row and every transactions index
// (idx_transactions_date, idx_transactions_account, idx_transactions_dedup,
// idx_transactions_import) survives the swap, that the constraint is still
// enforced (not accidentally dropped entirely), and that a repeat launch is a
// no-op.
describe('initDb transactions.source widened to include manual', () => {
  it('rewrites the CHECK constraint to allow manual', async () => {
    const row = (await db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'",
    )).rows[0] as unknown as { sql: string };
    expect(row.sql).toContain("'manual'");
  });

  it('recreates every transactions index the rebuild would otherwise drop', async () => {
    const objects = (await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions' AND name NOT LIKE 'sqlite_%'",
    )).rows as unknown as { name: string }[];
    expect(objects.map((o) => o.name).sort()).toEqual([
      'idx_transactions_account', 'idx_transactions_date',
      'idx_transactions_dedup', 'idx_transactions_import',
    ]);
  });

  it('still enforces the constraint against an unrelated value', async () => {
    await expect(db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, pending, ignored, source)
            VALUES ('bogus-1', 'chase', '2025-01-01', 'X', 1, 0, 0, 'bogus')`,
    })).rejects.toThrow(/CHECK/i);
  });

  it('keeps every pre-existing plaid and csv row exactly as it was, and accepts a manual row', async () => {
    expect(await column('A1b2C3d4E5f6G7h8', 'source')).toBe('plaid');
    expect(Number(await column('A1b2C3d4E5f6G7h8', 'amount'))).toBe(25);
    expect(await column('csv-aaaa1111bbbb2222', 'source')).toBe('csv');

    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored, source, manual_category)
            VALUES ('manual-test-1', 'chase', '2025-01-15', 'HAND ENTERED', 100, 'Bills & Utilities', 0, 0, 'manual', 'Bills & Utilities')`,
    });
    expect(await column('manual-test-1', 'source')).toBe('manual');
  });

  it('is idempotent — a second launch does not touch the widened table again', async () => {
    const before = (await db.execute('SELECT id, source FROM transactions ORDER BY rowid')).rows;
    const { initDb } = await import('../core/db.js');
    await expect(initDb()).resolves.not.toThrow();
    const after = (await db.execute('SELECT id, source FROM transactions ORDER BY rowid')).rows;
    expect(after).toEqual(before);
    const leftover = await db.execute(
      "SELECT name FROM sqlite_master WHERE name = 'transactions_new'",
    );
    expect(leftover.rows).toHaveLength(0);
  });
});
