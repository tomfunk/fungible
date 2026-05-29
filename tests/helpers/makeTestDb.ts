import { DatabaseSync } from 'node:sqlite';

type DbRow = Record<string, unknown>;
type ExecResult = { rows: DbRow[]; rowsAffected: number };
type Statement = { sql: string; args?: unknown[] };

/**
 * Hybrid test database:
 * - `execute` / `batch` match the @libsql/client async interface used by core code
 * - `prepare` / `exec` are synchronous pass-throughs for concise test setup
 */
export type TestDb = {
  execute(sqlOrObj: string | Statement): Promise<ExecResult>;
  batch(statements: Statement[], mode?: string): Promise<ExecResult[]>;
  prepare: DatabaseSync['prepare'];
  exec(sql: string): void;
};

export function makeTestDb(): TestDb {
  const sqlite = new DatabaseSync(':memory:');

  sqlite.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      institution_name TEXT,
      mask TEXT,
      nickname TEXT
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
      ignored INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE category_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL DEFAULT 0,
      match_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      min_amount REAL,
      max_amount REAL
    );

    CREATE TABLE name_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      replacement TEXT NOT NULL,
      min_amount REAL,
      max_amount REAL
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
      PRIMARY KEY (transaction_id, tag_id)
    );

    CREATE TABLE sync_state (account_id TEXT PRIMARY KEY, cursor TEXT);

    CREATE TABLE plaid_items (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      institution_name TEXT,
      last_synced_at INTEGER
    );

    CREATE TABLE balance_history (
      account_id TEXT NOT NULL,
      balance REAL NOT NULL,
      date TEXT NOT NULL,
      PRIMARY KEY (account_id, date)
    );
  `);

  function run(sql: string, args: unknown[] = []): ExecResult {
    const stmt = sqlite.prepare(sql);
    const trimmed = sql.trimStart().toLowerCase();
    const isRead = trimmed.startsWith('select') || trimmed.startsWith('with') || trimmed.startsWith('pragma');
    if (isRead) {
      const rows = stmt.all(...(args as Parameters<typeof stmt.all>)) as DbRow[];
      return { rows, rowsAffected: 0 };
    } else {
      const info = stmt.run(...(args as Parameters<typeof stmt.run>)) as { changes: number };
      return { rows: [], rowsAffected: info.changes ?? 0 };
    }
  }

  return {
    async execute(sqlOrObj) {
      const sql = typeof sqlOrObj === 'string' ? sqlOrObj : sqlOrObj.sql;
      const args = typeof sqlOrObj === 'string' ? [] : (sqlOrObj.args ?? []);
      return run(sql, args);
    },
    async batch(statements) {
      return statements.map(({ sql, args = [] }) => run(sql, args));
    },
    prepare: (sql: string) => sqlite.prepare(sql),
    exec: (sql: string) => sqlite.exec(sql),
  };
}
