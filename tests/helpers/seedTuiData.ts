import type { Client } from '@libsql/client';

/**
 * Seeds a small but representative dataset into the given in-memory DB.
 * All transactions are in 2026-05 (or 2026-04 for prior-period comparisons)
 * so tests can target a fixed period via initialFilter anchor.
 */
export async function seedTuiData(db: Client) {
  await db.batch(
    [
      // Accounts
      `INSERT INTO accounts (id, name, type, subtype, institution_name, mask)
       VALUES ('test-checking', 'Test Checking', 'depository', 'checking', 'Test Bank', '0001')`,
      `INSERT INTO accounts (id, name, type, subtype, institution_name, mask)
       VALUES ('test-credit', 'Test Visa', 'credit', 'credit card', 'Test Bank', '0002')`,

      // May 2026 transactions
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-income',   'test-checking', '2026-05-01', 'Direct Deposit', -3500.00, 'Income', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-groc-1',   'test-credit',   '2026-05-06', 'Whole Foods',    120.00,   'Grocery', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-groc-2',   'test-credit',   '2026-05-14', 'Trader Joes',     85.00,   'Grocery', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-dining-1', 'test-credit',   '2026-05-09', 'Sweetgreen',      45.00,   'Dining', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-bills-1',  'test-credit',   '2026-05-03', 'Con Edison',      95.00,   'Bills & Utilities', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-shopping', 'test-credit',   '2026-05-11', 'Amazon',          43.99,   'Shopping', 0, 0)`,

      // April 2026 transactions (for prior-period drift)
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-income-apr', 'test-checking', '2026-04-01', 'Direct Deposit', -3500.00, 'Income', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-groc-apr',   'test-credit',   '2026-04-08', 'Whole Foods',    100.00,   'Grocery', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-dining-apr', 'test-credit',   '2026-04-15', 'Sweetgreen',      40.00,   'Dining', 0, 0)`,

      // Flexibility tiers
      `INSERT INTO categories (name, flexibility) VALUES ('Grocery', 'flexible')`,
      `INSERT INTO categories (name, flexibility) VALUES ('Dining', 'discretionary')`,
      `INSERT INTO categories (name, flexibility) VALUES ('Bills & Utilities', 'fixed')`,
      `INSERT INTO categories (name, flexibility) VALUES ('Shopping', 'discretionary')`,
      `INSERT INTO categories (name, flexibility) VALUES ('Income', NULL)`,

      // Category rule
      `INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Whole Foods', 'Grocery')`,

      // Tags
      `INSERT INTO tags (id, name) VALUES (1, 'travel')`,
      `INSERT INTO tags (id, name) VALUES (2, 'work')`,

      // Balance history (required for NetWorth accounts view)
      `INSERT INTO balance_history (account_id, balance, date) VALUES ('test-checking', 5000.00, '2026-05-20')`,
      `INSERT INTO balance_history (account_id, balance, date) VALUES ('test-credit', -450.00, '2026-05-20')`,
    ],
    'write',
  );
}
