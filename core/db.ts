import { createClient, type Client } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { encryptToken } from './crypto.js';
import { DATA_DIR } from './paths.js';
import { BASE_USER_VERSION } from './schema-version.js';
import { CREATE_TABLES, COLUMN_MIGRATIONS, FLEX_DEFAULTS, HIDDEN_CATEGORY_DEFAULTS, DEFAULT_CATEGORIES } from './db-schema.js';
import { registerInUse } from './in-use.js';

const DB_PATH = path.join(DATA_DIR, 'fungible.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// libsql defaults to busy_timeout=0, so a second process (TUI/GUI plus the MCP
// server) writing the same file fails instantly with SQLITE_BUSY instead of
// waiting its turn. Wait up to this long for the other writer to commit.
export const BUSY_TIMEOUT_MS = 5000;

export const db: Client = createClient({ url: `file:${DB_PATH}` });
// Not awaited (no top-level await: this module is bundled into the Electron
// main process). The file-backed libsql client runs statements synchronously
// on one connection, so the pragma takes effect before any later query.
db.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`).catch(() => {});

export async function initDb() {
  // Additive and failure-tolerant: lets `fungible restore` see this process.
  registerInUse(DATA_DIR);
  // Create all tables (idempotent)
  await db.batch(CREATE_TABLES, 'write');

  // Idempotent column migrations (each may fail if column exists — that's fine)
  const migrations = COLUMN_MIGRATIONS;
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
  }

  // Widen transactions.source to allow 'manual' (hand-entered rows, e.g. a
  // transaction Plaid's sync never reports). SQLite can't ALTER a CHECK
  // constraint, so this is the standard rebuild: a copy of the table with the
  // wider CHECK, every row copied over, then swapped in under the original
  // name. Guarded by reading the live schema text back from sqlite_master
  // rather than try/catch-on-error, since — unlike the single ADD COLUMN
  // statements above — this isn't one idempotent statement to retry.
  //
  // DROP TABLE takes every index on `transactions` down with it. The two
  // created right after the original CREATE TABLE (idx_transactions_date,
  // idx_transactions_account) only ever get created at first bootstrap, so
  // they're recreated here explicitly; idx_transactions_dedup and
  // idx_transactions_import are recreated further down by their own
  // pre-existing `CREATE ... IF NOT EXISTS` statements, unchanged.
  //
  // `transaction_tags.transaction_id` has an FK to `transactions(id)`. On a
  // real database with tagged transactions, FK enforcement in the local
  // sqlite3 driver `@libsql/client` actually uses is on (unlike the assumption
  // this comment used to make, based only on nothing ever issuing
  // `PRAGMA foreign_keys=ON` explicitly) — dropping the parent table while
  // those child rows still reference it fails with SQLITE_CONSTRAINT_FOREIGNKEY.
  // SQLite's own recommended procedure for an FK-constrained rebuild is to
  // bracket it in `PRAGMA foreign_keys=OFF` / `=ON`, and that pragma is
  // documented as a no-op inside an active transaction — so it has to sit
  // outside `db.batch`, as its own `db.execute` calls, not as statements
  // inside the batch (which runs as one transaction).
  const txSchema = await db.execute(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'`,
  );
  const txSchemaSql = (txSchema.rows[0] as unknown as { sql: string } | undefined)?.sql ?? '';
  if (!txSchemaSql.includes("'manual'")) {
    await db.execute('PRAGMA foreign_keys = OFF');
    await db.batch([
      `CREATE TABLE transactions_new (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        merchant_name TEXT,
        amount REAL NOT NULL,
        category TEXT,
        raw_category TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        manual_category TEXT,
        display_name TEXT,
        ignored INTEGER NOT NULL DEFAULT 0,
        original_date TEXT,
        source TEXT CHECK(source IN ('plaid','csv','manual')),
        import_id INTEGER,
        dedup_key TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts(id)
      )`,
      `INSERT INTO transactions_new (
        id, account_id, date, name, merchant_name, amount, category, raw_category, pending,
        manual_category, display_name, ignored, original_date, source, import_id, dedup_key
      )
      SELECT
        id, account_id, date, name, merchant_name, amount, category, raw_category, pending,
        manual_category, display_name, ignored, original_date, source, import_id, dedup_key
      FROM transactions`,
      `DROP TABLE transactions`,
      `ALTER TABLE transactions_new RENAME TO transactions`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`,
    ], 'write');
    await db.execute('PRAGMA foreign_keys = ON');
  }

  // Label existing rows by provenance. Until now the only signal was the id
  // prefix the CSV importer wrote, so that prefix is what seeds the column —
  // once, after which the column is authoritative and the prefix is just a
  // namespace. Anything not written by the CSV importer came from Plaid.
  await db.execute(
    `UPDATE transactions SET source = CASE WHEN id LIKE 'csv-%' THEN 'csv' ELSE 'plaid' END
     WHERE source IS NULL`,
  );

  // Give pre-existing CSV rows a dedup_key so a later re-import of the same
  // statement recognises them instead of inserting duplicates. They keep their
  // old hash-derived ids — nothing is rewritten — and they have no import_id,
  // because there is no record of which file they came from. The UI shows them
  // as predating import history.
  //
  // Ordinals are assigned here rather than in SQL so one implementation produces
  // every key in the database (SQLite's LOWER() is ASCII-only, JS toLowerCase is
  // not, and the two disagree on names like CAFÉ). Assigning them by construction
  // also guarantees the batch cannot violate the unique index created below.
  const legacyCsv = await db.execute(
    `SELECT id, date, name, amount FROM transactions
     WHERE source = 'csv' AND dedup_key IS NULL ORDER BY rowid`,
  );
  if (legacyCsv.rows.length > 0) {
    const { assignOrdinals, dedupKey } = await import('./csv.js');
    const rows = legacyCsv.rows as unknown as { id: string; date: string; name: string; amount: number }[];
    await db.batch(
      assignOrdinals(rows.map((r) => ({ ...r, amount: Number(r.amount) }))).map((r) => ({
        sql: 'UPDATE transactions SET dedup_key = ? WHERE id = ?',
        args: [dedupKey(r.date, r.name, r.amount, r.ord), r.id],
      })),
      'write',
    );
  }

  // Created after the backfill, so a database that somehow already holds
  // colliding rows fails here rather than silently dropping one of them.
  // Partial: Plaid rows have no dedup_key, and NULLs would not be constrained
  // anyway — saying so keeps the index small and the intent explicit.
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedup
     ON transactions(account_id, dedup_key) WHERE dedup_key IS NOT NULL`,
  );
  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_import ON transactions(import_id)');

  // Backfill (#200): importCsvTransactions never wrote a balance_history row
  // until this fix, so a CSV-imported account that predates it has none.
  // Every net-worth/health query inner-joins balance_history on MAX(date),
  // so such an account doesn't show up as zero or stale -- it's just silently
  // absent. One-time only: an account is skipped here once it has any
  // balance_history row of its own, csv-imported or not.
  const csvAccountsMissingBalance = await db.execute(
    `SELECT DISTINCT account_id FROM transactions t
     WHERE t.source = 'csv'
       AND NOT EXISTS (SELECT 1 FROM balance_history bh WHERE bh.account_id = t.account_id)`,
  );
  if (csvAccountsMissingBalance.rows.length > 0) {
    const { recomputeAccountBalance } = await import('./accounts.js');
    const rows = csvAccountsMissingBalance.rows as unknown as { account_id: string }[];
    for (const r of rows) await recomputeAccountBalance(r.account_id);
  }

  // Seed default flexibility tiers (only where not already set)
  const flexDefaults = FLEX_DEFAULTS;
  await db.batch(
    flexDefaults.map(([cat, flex]) => ({
      sql: 'UPDATE categories SET flexibility = ? WHERE name = ? AND flexibility IS NULL',
      args: [flex, cat],
    })),
    'write',
  );

  // Migrate plaintext Plaid access tokens to encrypted form (idempotent)
  const itemsRes = await db.execute('SELECT item_id, access_token FROM plaid_items');
  const plainItems = (itemsRes.rows as unknown as { item_id: string; access_token: string }[])
    .filter((r) => !r.access_token.includes(':'));
  if (plainItems.length > 0) {
    await db.batch(
      plainItems.map((item) => ({
        sql: 'UPDATE plaid_items SET access_token = ? WHERE item_id = ?',
        args: [encryptToken(item.access_token), item.item_id],
      })),
      'write',
    );
  }

  // Seed default hidden categories
  await db.batch(
    HIDDEN_CATEGORY_DEFAULTS.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO hidden_categories (category) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // One-time migration: seed household_members from profile.json if table is empty
  const hmCount = await db.execute('SELECT COUNT(*) as n FROM household_members');
  if (Number(hmCount.rows[0].n) === 0) {
    type ProfileJson = { self: { name: string; birthYear: number }; spouse?: { name: string; birthYear: number }; children: { name: string; birthYear: number }[] };
    let p: ProfileJson | null = null;
    try { p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'profile.json'), 'utf8')) as ProfileJson; } catch {}
    const self = p?.self ?? { name: '', birthYear: 0 };
    const rows: { sql: string; args: (string | number)[] }[] = [
      { sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,0)', args: ['self', self.name, self.birthYear] },
    ];
    if (p?.spouse) rows.push({ sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,1)', args: ['spouse', p.spouse.name, p.spouse.birthYear] });
    for (let i = 0; i < (p?.children ?? []).length; i++) {
      const c = p!.children[i];
      rows.push({ sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,?)', args: [`child-${i}`, c.name, c.birthYear, i + 2] });
    }
    await db.batch(rows, 'write');
  }

  // Seed default categories
  const defaultCategories = DEFAULT_CATEGORIES;
  await db.batch(
    defaultCategories.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // Stamp the schema version on databases that predate it (user_version 0).
  // Never lowers or rewrites a non-zero value.
  const uv = await db.execute('PRAGMA user_version');
  if (Number((uv.rows[0] as unknown as { user_version: number | bigint }).user_version) === 0) {
    await db.execute(`PRAGMA user_version = ${BASE_USER_VERSION}`);
  }
}
