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
  ];
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
  }

  // Seed default flexibility tiers (only where not already set)
  const flexDefaults: [string, string][] = [
    ['Rent', 'fixed'], ['Insurance', 'fixed'], ['Childcare', 'fixed'],
    ['Loan Payment', 'fixed'], ['Taxes', 'fixed'], ['Government', 'fixed'],
    ['Bills & Utilities', 'fixed'], ['Medical', 'fixed'],
    ['Food & Drink', 'flexible'], ['Grocery', 'flexible'], ['Transportation', 'flexible'],
    ['Personal Care', 'flexible'], ['Home', 'flexible'], ['Services', 'flexible'],
    ['Shopping', 'discretionary'], ['Entertainment', 'discretionary'],
    ['Travel', 'discretionary'], ['Dining', 'discretionary'], ['Fees', 'discretionary'],
    // Streaming and cloud storage — cancellable, so discretionary rather than
    // fixed. Must stay in step with the seeded Subscriptions rules in
    // core/seed-rules.ts: a category with no tier here falls to 'untagged' in
    // every fixed/flexible/discretionary breakdown.
    ['Subscriptions', 'discretionary'],
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
    'Government', 'Taxes', 'Loan Payment', 'Subscriptions', 'Uncategorized',
  ];
  await db.batch(
    defaultCategories.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );
}
