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
    const ids = (await db.execute('SELECT id FROM transactions ORDER BY rowid')).rows as unknown as { id: string }[];
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
