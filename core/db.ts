import { createClient, type Client } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { encryptToken } from './crypto.js';
import { DATA_DIR } from './paths.js';

const DB_PATH = path.join(DATA_DIR, 'fungible.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db: Client = createClient({ url: `file:${DB_PATH}` });

export async function initDb() {
  // Create all tables (idempotent)
  await db.batch([
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      institution_name TEXT,
      mask TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      merchant_name TEXT,
      amount REAL NOT NULL,
      category TEXT,
      raw_category TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`,
    `CREATE TABLE IF NOT EXISTS category_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL DEFAULT 0,
      match_type TEXT NOT NULL CHECK(match_type IN ('name', 'regex')),
      pattern TEXT NOT NULL,
      category TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT PRIMARY KEY,
      cursor TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      institution_name TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS hidden_categories (
      category TEXT PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS name_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL CHECK(match_type IN ('name', 'regex')),
      pattern TEXT NOT NULL,
      replacement TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (transaction_id, tag_id),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tag_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL DEFAULT 0,
      match_type TEXT NOT NULL CHECK(match_type IN ('name','regex','all')),
      pattern TEXT NOT NULL DEFAULT '',
      tag_id INTEGER NOT NULL,
      account_id TEXT,
      min_amount REAL,
      max_amount REAL,
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tag_rule_suppressions (
      transaction_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (transaction_id, tag_id)
    )`,
    `CREATE TABLE IF NOT EXISTS balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      balance REAL NOT NULL,
      date TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_history_acct_date
      ON balance_history(account_id, date)`,
    `CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      imported INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      min_date TEXT,
      max_date TEXT,
      config TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS household_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      birth_year INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
  ], 'write');

  // Idempotent column migrations (each may fail if column exists — that's fine)
  const migrations = [
    'ALTER TABLE transactions ADD COLUMN manual_category TEXT',
    'ALTER TABLE transactions ADD COLUMN display_name TEXT',
    'ALTER TABLE transactions ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE category_rules ADD COLUMN min_amount REAL',
    'ALTER TABLE category_rules ADD COLUMN max_amount REAL',
    'ALTER TABLE name_rules ADD COLUMN min_amount REAL',
    'ALTER TABLE name_rules ADD COLUMN max_amount REAL',
    "ALTER TABLE categories ADD COLUMN flexibility TEXT CHECK(flexibility IN ('fixed','flexible','discretionary'))",
    'ALTER TABLE plaid_items ADD COLUMN last_synced_at INTEGER',
    'ALTER TABLE plaid_items ADD COLUMN days_requested INTEGER',
    'ALTER TABLE accounts ADD COLUMN nickname TEXT',
    'ALTER TABLE accounts ADD COLUMN owner TEXT',
    'ALTER TABLE accounts ADD COLUMN apr REAL',
    'ALTER TABLE accounts ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE accounts ADD COLUMN item_id TEXT',
    'ALTER TABLE category_rules ADD COLUMN account_id TEXT',
    'ALTER TABLE name_rules ADD COLUMN account_id TEXT',
    "ALTER TABLE transactions ADD COLUMN source TEXT CHECK(source IN ('plaid','csv'))",
    'ALTER TABLE transactions ADD COLUMN import_id INTEGER',
    'ALTER TABLE transactions ADD COLUMN dedup_key TEXT',
  ];
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
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

  // Seed default flexibility tiers (only where not already set)
  const flexDefaults: [string, string][] = [
    ['Rent', 'fixed'], ['Insurance', 'fixed'], ['Childcare', 'fixed'],
    ['Loan Payment', 'fixed'], ['Taxes', 'fixed'], ['Government', 'fixed'],
    ['Bills & Utilities', 'fixed'], ['Medical', 'fixed'],
    ['Food & Drink', 'flexible'], ['Grocery', 'flexible'], ['Transportation', 'flexible'],
    ['Personal Care', 'flexible'], ['Home', 'flexible'], ['Services', 'flexible'],
    ['Shopping', 'discretionary'], ['Entertainment', 'discretionary'],
    ['Travel', 'discretionary'], ['Dining', 'discretionary'], ['Fees', 'discretionary'],
  ];
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
    ['Transfer', 'Loan Payment'].map((cat) => ({
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
  const defaultCategories = [
    'Income', 'Transfer', 'Food & Drink', 'Shopping', 'Transportation',
    'Travel', 'Bills & Utilities', 'Insurance', 'Medical', 'Personal Care',
    'Childcare', 'Entertainment', 'Home', 'Services', 'Fees',
    'Government', 'Taxes', 'Loan Payment', 'Uncategorized',
  ];
  await db.batch(
    defaultCategories.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );
}
