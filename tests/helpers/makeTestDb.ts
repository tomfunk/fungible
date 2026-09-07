import { createClient } from '@libsql/client';

const SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT,
    institution_name TEXT,
    mask TEXT,
    nickname TEXT,
    owner TEXT,
    apr REAL,
    excluded INTEGER NOT NULL DEFAULT 0,
    item_id TEXT
  );

  CREATE TABLE transactions (
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
    original_date TEXT
  );

  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    priority INTEGER NOT NULL DEFAULT 0,
    match_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    category TEXT NOT NULL,
    min_amount REAL,
    max_amount REAL,
    account_id TEXT
  );

  CREATE TABLE name_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    replacement TEXT NOT NULL,
    min_amount REAL,
    max_amount REAL,
    account_id TEXT
  );

  CREATE TABLE hidden_categories (category TEXT PRIMARY KEY);

  CREATE TABLE categories (
    name TEXT PRIMARY KEY,
    flexibility TEXT CHECK(flexibility IN ('fixed','flexible','discretionary'))
  );

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, tag_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  );

  CREATE TABLE tag_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    priority INTEGER NOT NULL DEFAULT 0,
    match_type TEXT NOT NULL,
    pattern TEXT NOT NULL DEFAULT '',
    tag_id INTEGER NOT NULL,
    account_id TEXT,
    min_amount REAL,
    max_amount REAL
  );

  CREATE TABLE tag_rule_suppressions (
    transaction_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, tag_id)
  );

  CREATE TABLE sync_state (account_id TEXT PRIMARY KEY, cursor TEXT);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE plaid_items (
    item_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    institution_name TEXT,
    last_synced_at INTEGER,
    days_requested INTEGER
  );

  CREATE TABLE balance_history (
    account_id TEXT NOT NULL,
    balance REAL NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (account_id, date)
  );

  CREATE TABLE household_members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    birth_year INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`;

export async function makeTestDb() {
  const db = createClient({ url: ':memory:' });
  await db.execute('PRAGMA foreign_keys = ON');
  // Execute each statement separately (libsql in-memory doesn't support multi-statement strings)
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  return db;
}
