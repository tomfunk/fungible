// Pure schema constants shared between the Node (db.ts) and browser
// (db.browser.ts) database implementations. NO imports: safe for any bundle.
// Node-only one-time migrations (encrypted Plaid tokens, profile.json seeding,
// legacy CSV dedup backfill, transactions CHECK rebuild) stay in db.ts.
// Keep statement order: some ALTERs depend on earlier ones.

export const CREATE_TABLES: string[] = [
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
];

export const COLUMN_MIGRATIONS: string[] = [
  'ALTER TABLE transactions ADD COLUMN manual_category TEXT',
  'ALTER TABLE transactions ADD COLUMN display_name TEXT',
  'ALTER TABLE transactions ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0',
  // Set when the user reattributes a transaction to the period it belongs to
  // (a paycheck posting on the 1st, a check cashed months after it was written).
  // Holds the original posting date; `date` holds the reattributed one.
  'ALTER TABLE transactions ADD COLUMN original_date TEXT',
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

// Default flexibility tiers, seeded only where not already set.
export const FLEX_DEFAULTS: [string, string][] = [
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

export const HIDDEN_CATEGORY_DEFAULTS: string[] = ['Transfer', 'Loan Payment'];

export const DEFAULT_CATEGORIES: string[] = [
  'Income', 'Transfer', 'Food & Drink', 'Shopping', 'Transportation',
  'Travel', 'Bills & Utilities', 'Insurance', 'Medical', 'Personal Care',
  'Childcare', 'Entertainment', 'Home', 'Services', 'Fees',
  'Government', 'Taxes', 'Loan Payment', 'Subscriptions', 'Uncategorized',
];

// A fresh database can take the widened transactions.source CHECK directly;
// Node databases that predate 'manual' get the table rebuild in db.ts instead.
export const SOURCE_COLUMN_WIDE_SQL =
  "ALTER TABLE transactions ADD COLUMN source TEXT CHECK(source IN ('plaid','csv','manual'))";
