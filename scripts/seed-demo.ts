/**
 * Seed a demo database with realistic fake transactions.
 * Called automatically when running `fungible --demo` on a fresh data dir.
 */
import { db } from '../core/db.js';
import { seedRules } from '../core/seed-rules.js';

export async function seedDemo() {
  const countResult = await db.execute('SELECT COUNT(*) as c FROM transactions');
  const existing = (countResult.rows[0] as unknown as { c: number }).c;
  if (existing > 0) return; // already seeded

  await seedRules();

// ── Accounts ──────────────────────────────────────────────────────────────────

await db.batch([
  { sql: `INSERT OR IGNORE INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['demo-checking', 'Everyday Checking', 'depository', 'checking', 'First National Bank', '4242'] },
  { sql: `INSERT OR IGNORE INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['demo-savings', 'High-Yield Savings', 'depository', 'savings', 'First National Bank', '8888'] },
  { sql: `INSERT OR IGNORE INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['demo-credit', 'Rewards Visa', 'credit', 'credit card', 'Chase', '1234'] },
  { sql: `INSERT OR IGNORE INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['demo-brokerage', 'Brokerage', 'investment', 'brokerage', 'Fidelity', '5678'] },
], 'write');

// ── Transactions ──────────────────────────────────────────────────────────────

const txns: [string, string, string, string, string | null, number, string][] = [
  // Income
  ['demo-t001', 'demo-checking', '2026-05-01', 'Direct Deposit - Acme Corp',    null,              -4200.00, 'Income'],
  ['demo-t002', 'demo-savings',  '2026-05-01', 'Interest Payment',               null,              -12.50,   'Income'],
  ['demo-t003', 'demo-checking', '2026-04-01', 'Direct Deposit - Acme Corp',    null,              -4200.00, 'Income'],
  ['demo-t004', 'demo-checking', '2026-03-01', 'Direct Deposit - Acme Corp',    null,              -4200.00, 'Income'],

  // Rent / Fixed
  ['demo-t010', 'demo-checking', '2026-05-02', 'Rent Payment',                  null,               1850.00, 'Rent'],
  ['demo-t011', 'demo-checking', '2026-04-02', 'Rent Payment',                  null,               1850.00, 'Rent'],
  ['demo-t012', 'demo-checking', '2026-03-02', 'Rent Payment',                  null,               1850.00, 'Rent'],

  // Bills & Utilities
  ['demo-t020', 'demo-credit',   '2026-05-03', 'Con Edison',                    'Con Edison',        92.40,  'Bills & Utilities'],
  ['demo-t021', 'demo-credit',   '2026-05-04', 'Verizon Wireless',              'Verizon',           85.00,  'Bills & Utilities'],
  ['demo-t022', 'demo-credit',   '2026-05-05', 'Spotify',                       'Spotify',           11.99,  'Bills & Utilities'],
  ['demo-t023', 'demo-credit',   '2026-05-05', 'Netflix',                       'Netflix',           15.99,  'Entertainment'],
  ['demo-t024', 'demo-credit',   '2026-04-03', 'Con Edison',                    'Con Edison',        88.10,  'Bills & Utilities'],
  ['demo-t025', 'demo-credit',   '2026-04-04', 'Verizon Wireless',              'Verizon',           85.00,  'Bills & Utilities'],

  // Groceries
  ['demo-t030', 'demo-credit',   '2026-05-06', 'Whole Foods Market',            'Whole Foods',       87.43,  'Grocery'],
  ['demo-t031', 'demo-credit',   '2026-05-10', "Trader Joe's",                  "Trader Joe's",      54.21,  'Grocery'],
  ['demo-t032', 'demo-credit',   '2026-05-16', 'Whole Foods Market',            'Whole Foods',       63.80,  'Grocery'],
  ['demo-t033', 'demo-credit',   '2026-04-07', 'Whole Foods Market',            'Whole Foods',       91.20,  'Grocery'],
  ['demo-t034', 'demo-credit',   '2026-04-14', "Trader Joe's",                  "Trader Joe's",      48.60,  'Grocery'],
  ['demo-t035', 'demo-credit',   '2026-03-09', 'Whole Foods Market',            'Whole Foods',       79.40,  'Grocery'],
  ['demo-t036', 'demo-credit',   '2026-03-20', "Trader Joe's",                  "Trader Joe's",      61.30,  'Grocery'],

  // Dining
  ['demo-t040', 'demo-credit',   '2026-05-07', 'Sweetgreen',                    'Sweetgreen',        16.50,  'Dining'],
  ['demo-t041', 'demo-credit',   '2026-05-09', 'Tacos El Patron',               null,                24.00,  'Dining'],
  ['demo-t042', 'demo-credit',   '2026-05-12', 'Blue Bottle Coffee',            'Blue Bottle',        6.75,  'Food & Drink'],
  ['demo-t043', 'demo-credit',   '2026-05-14', 'The Dutch',                     null,                78.40,  'Dining'],
  ['demo-t044', 'demo-credit',   '2026-05-19', 'Sweetgreen',                    'Sweetgreen',        15.75,  'Dining'],
  ['demo-t045', 'demo-credit',   '2026-04-08', 'Tacos El Patron',               null,                21.50,  'Dining'],
  ['demo-t046', 'demo-credit',   '2026-04-11', 'Ramen Nagi',                    null,                32.00,  'Dining'],
  ['demo-t047', 'demo-credit',   '2026-04-18', 'Blue Bottle Coffee',            'Blue Bottle',        6.75,  'Food & Drink'],
  ['demo-t048', 'demo-credit',   '2026-03-13', 'Sweetgreen',                    'Sweetgreen',        16.50,  'Dining'],
  ['demo-t049', 'demo-credit',   '2026-03-22', 'The Dutch',                     null,                95.20,  'Dining'],

  // Transportation
  ['demo-t050', 'demo-credit',   '2026-05-08', 'Lyft',                          'Lyft',              14.20,  'Transportation'],
  ['demo-t051', 'demo-credit',   '2026-05-13', 'Lyft',                          'Lyft',              11.80,  'Transportation'],
  ['demo-t052', 'demo-credit',   '2026-05-17', 'MTA NYC Transit',               'MTA',               33.00,  'Transportation'],
  ['demo-t053', 'demo-credit',   '2026-04-10', 'Lyft',                          'Lyft',              18.50,  'Transportation'],
  ['demo-t054', 'demo-credit',   '2026-04-15', 'MTA NYC Transit',               'MTA',               33.00,  'Transportation'],

  // Shopping
  ['demo-t060', 'demo-credit',   '2026-05-11', 'Amazon',                        'Amazon',            43.99,  'Shopping'],
  ['demo-t061', 'demo-credit',   '2026-05-15', 'Uniqlo',                        'Uniqlo',            89.00,  'Shopping'],
  ['demo-t062', 'demo-credit',   '2026-04-20', 'Amazon',                        'Amazon',            27.50,  'Shopping'],
  ['demo-t063', 'demo-credit',   '2026-03-17', 'Amazon',                        'Amazon',           112.34,  'Shopping'],

  // Health
  ['demo-t070', 'demo-credit',   '2026-05-02', 'Equinox',                       'Equinox',          135.00,  'Personal Care'],
  ['demo-t071', 'demo-credit',   '2026-05-18', 'CVS Pharmacy',                  'CVS',               22.40,  'Medical'],
  ['demo-t072', 'demo-credit',   '2026-04-02', 'Equinox',                       'Equinox',          135.00,  'Personal Care'],
  ['demo-t073', 'demo-credit',   '2026-03-02', 'Equinox',                       'Equinox',          135.00,  'Personal Care'],

  // Travel (Tokyo trip — for tag demo)
  ['demo-t080', 'demo-credit',   '2026-04-22', 'Japan Airlines',                'JAL',              890.00,  'Travel'],
  ['demo-t081', 'demo-credit',   '2026-04-23', 'APA Hotel Tokyo',               null,               420.00,  'Travel'],
  ['demo-t082', 'demo-credit',   '2026-04-24', 'Ichiran Ramen',                 null,                18.00,  'Dining'],
  ['demo-t083', 'demo-credit',   '2026-04-24', 'Tokyo Metro',                   null,                12.00,  'Transportation'],
  ['demo-t084', 'demo-credit',   '2026-04-25', 'Tsukiji Market',                null,                34.00,  'Food & Drink'],
  ['demo-t085', 'demo-credit',   '2026-04-26', 'Don Quijote',                   null,                67.00,  'Shopping'],
  ['demo-t086', 'demo-credit',   '2026-04-27', 'APA Hotel Tokyo',               null,               420.00,  'Travel'],
  ['demo-t087', 'demo-credit',   '2026-04-28', 'Japan Airlines',                'JAL',              890.00,  'Travel'],

  // Credit card payment (transfer)
  ['demo-t090', 'demo-checking', '2026-05-15', 'Chase Credit Card Payment',     null,             -1200.00,  'Transfer'],
  ['demo-t091', 'demo-checking', '2026-04-15', 'Chase Credit Card Payment',     null,             -1100.00,  'Transfer'],
];

await db.batch(
  txns.map(([id, acct, date, name, merchant, amount, category]) => ({
    sql: `INSERT OR IGNORE INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, pending)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [id, acct, date, name, merchant, amount, category, category],
  })),
  'write',
);

// ── Balance history ────────────────────────────────────────────────────────────

const balances: [string, number, string][] = [
  ['demo-checking',   8420.00, '2026-05-25'],
  ['demo-checking',   6810.00, '2026-04-30'],
  ['demo-checking',   5990.00, '2026-03-31'],
  ['demo-savings',   18500.00, '2026-05-25'],
  ['demo-savings',   18200.00, '2026-04-30'],
  ['demo-savings',   17900.00, '2026-03-31'],
  ['demo-credit',    -1340.00, '2026-05-25'],
  ['demo-credit',     -980.00, '2026-04-30'],
  ['demo-credit',    -1120.00, '2026-03-31'],
  ['demo-brokerage', 34200.00, '2026-05-25'],
  ['demo-brokerage', 32100.00, '2026-04-30'],
  ['demo-brokerage', 30500.00, '2026-03-31'],
];

await db.batch(
  balances.map(([acct, bal, date]) => ({
    sql: `INSERT OR IGNORE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)`,
    args: [acct, bal, date],
  })),
  'write',
);

// ── Tags ──────────────────────────────────────────────────────────────────────

await db.execute({ sql: `INSERT OR IGNORE INTO tags (name) VALUES (?)`, args: ['tokyo trip'] });
const tagResult = await db.execute(`SELECT id FROM tags WHERE name = 'tokyo trip'`);
const tagId = (tagResult.rows[0] as unknown as { id: number }).id;

await db.batch(
  ['demo-t080','demo-t081','demo-t082','demo-t083','demo-t084','demo-t085','demo-t086','demo-t087'].map((id) => ({
    sql: `INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`,
    args: [id, tagId],
  })),
  'write',
);

}
