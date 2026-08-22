import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  getRangeSummary,
  getFlexSummary,
  getHiddenCategories,
  getRecentTransactions,
  getMerchantSummary,
  getSearchFilteredData,
  getLastSyncedAt,
  getOwnerRows,
  hasAccounts,
  getTransactions,
  getNetWorthHistory,
  getAccountsWithBalances,
  getLinkedAccounts,
  getLinkedItems,
} from '../core/queries.js';

let txId = 0;
async function insertTx(opts: {
  date?: string;
  name?: string;
  merchantName?: string | null;
  displayName?: string | null;
  amount: number;
  category?: string;
  pending?: number;
  ignored?: number;
  accountId?: string;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, display_name, amount, category, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `tx${txId}`,
      opts.accountId ?? 'acct1',
      opts.date ?? '2025-01-15',
      opts.name ?? 'Test Transaction',
      opts.merchantName ?? null,
      opts.displayName ?? null,
      opts.amount,
      opts.category ?? 'Shopping',
      opts.pending ?? 0,
      opts.ignored ?? 0,
    ],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM hidden_categories');
  await db.execute('DELETE FROM categories');
  await db.execute('DELETE FROM accounts');
});

// ──────────────────────────────────────────────────────────────────────
describe('getHiddenCategories', () => {
  it('returns empty set when no hidden categories', async () => {
    expect((await getHiddenCategories()).size).toBe(0);
  });

  it('returns set of hidden category names', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Loan Payment'] });
    const hidden = await getHiddenCategories();
    expect(hidden.has('Transfer')).toBe(true);
    expect(hidden.has('Loan Payment')).toBe(true);
    expect(hidden.has('Shopping')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRangeSummary', () => {
  it('returns zeros for empty database', async () => {
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.income).toBe(0);
    expect(s.expenses).toBe(0);
    expect(s.net).toBe(0);
    expect(s.byCategory).toHaveLength(0);
  });

  it('separates expenses (positive amounts) from income (negative amounts)', async () => {
    await insertTx({ amount: 100, category: 'Shopping' });
    await insertTx({ amount: -200, category: 'Income' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
    expect(s.income).toBeCloseTo(200);
    expect(s.net).toBeCloseTo(100);
  });

  it('only includes dates within the range', async () => {
    await insertTx({ date: '2025-01-01', amount: 50, category: 'Shopping' });
    await insertTx({ date: '2025-01-31', amount: 50, category: 'Shopping' });
    await insertTx({ date: '2024-12-31', amount: 999, category: 'Shopping' });
    await insertTx({ date: '2025-02-01', amount: 999, category: 'Shopping' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
  });

  it('excludes pending transactions', async () => {
    await insertTx({ amount: 100, category: 'Shopping', pending: 1 });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBe(0);
  });

  it('excludes ignored transactions', async () => {
    await insertTx({ amount: 100, category: 'Shopping', ignored: 1 });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBe(0);
  });

  it('excludes hidden categories', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ amount: 500, category: 'Transfer' });
    await insertTx({ amount: 100, category: 'Shopping' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
  });

  it('nets refunds within a real category before classifying as income/expense', async () => {
    await insertTx({ amount: 1000, category: 'Travel' });
    await insertTx({ amount: -800, category: 'Travel' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(200);
    expect(s.income).toBe(0);
    expect(s.byCategory).toEqual([{ category: 'Travel', total: 200 }]);
  });

  it('real categories with a net negative total count as income (not spending)', async () => {
    await insertTx({ amount: 100, category: 'Rewards' });
    await insertTx({ amount: -200, category: 'Rewards' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.income).toBeCloseTo(100);
    expect(s.expenses).toBe(0);
    expect(s.byCategory).toHaveLength(0);
  });

  it('does NOT net Uncategorized: splits its outflows (spending) from inflows (income)', async () => {
    // Regression: a paycheck landing in the Uncategorized catch-all used to net the
    // bucket negative, hiding all uncategorized spending from byCategory. Uncategorized
    // is split by flow; the spending row stays labeled "Uncategorized".
    await insertTx({ amount: 1850, category: 'Uncategorized', name: 'Rent Payment' });
    await insertTx({ amount: 63.8, category: 'Uncategorized', name: 'Whole Foods Market' });
    await insertTx({ amount: -4200, category: 'Uncategorized', name: 'Direct Deposit' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(1913.8);
    expect(s.income).toBeCloseTo(4200);
    expect(s.byCategory).toEqual([{ category: 'Uncategorized', total: 1913.8 }]);
  });

  it('aggregates multiple categories correctly', async () => {
    await insertTx({ amount: 100, category: 'Food & Drink' });
    await insertTx({ amount: 200, category: 'Shopping' });
    await insertTx({ amount: -500, category: 'Income' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(300);
    expect(s.income).toBeCloseTo(500);
    expect(s.byCategory).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getFlexSummary', () => {
  async function insertCat(name: string, flexibility: string | null) {
    await db.execute({ sql: 'INSERT INTO categories (name, flexibility) VALUES (?, ?)', args: [name, flexibility] });
  }

  beforeEach(async () => {
    await db.execute('DELETE FROM categories');
  });

  it('returns zeros for empty database', async () => {
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
    expect(s.flexible).toBe(0);
    expect(s.discretionary).toBe(0);
    expect(s.untagged).toBe(0);
  });

  it('buckets spending by flexibility tier', async () => {
    await insertCat('Rent', 'fixed');
    await insertCat('Food & Drink', 'flexible');
    await insertCat('Entertainment', 'discretionary');
    await insertTx({ amount: 1500, category: 'Rent' });
    await insertTx({ amount: 300, category: 'Food & Drink' });
    await insertTx({ amount: 100, category: 'Entertainment' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBeCloseTo(1500);
    expect(s.flexible).toBeCloseTo(300);
    expect(s.discretionary).toBeCloseTo(100);
    expect(s.untagged).toBe(0);
  });

  it('puts spending with no flexibility tag in untagged', async () => {
    await insertCat('Mystery', null);
    await insertTx({ amount: 50, category: 'Mystery' });
    await insertTx({ amount: 75, category: 'UnknownCat' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.untagged).toBeCloseTo(125);
  });

  it('nets out refunds in a real category before bucketing — no tier inflation (regression)', async () => {
    await insertCat('Travel', 'discretionary');
    await insertTx({ amount: 10000, category: 'Travel' });
    await insertTx({ amount: -8000, category: 'Travel' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBeCloseTo(2000);
    expect(s.fixed).toBe(0);
    expect(s.flexible).toBe(0);
  });

  it('excludes a real category whose net is negative (refund-heavy)', async () => {
    await insertCat('Travel', 'discretionary');
    await insertTx({ amount: 100, category: 'Travel' });
    await insertTx({ amount: -500, category: 'Travel' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBe(0);
  });

  it('buckets Uncategorized outflow into untagged even when it holds a larger inflow', async () => {
    // Uncategorized has no flexibility tag → untagged tier; its spending must show
    // even though the bucket nets negative from an inflow (e.g. a paycheck).
    await insertTx({ amount: 200, category: 'Uncategorized' });
    await insertTx({ amount: -5000, category: 'Uncategorized' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.untagged).toBeCloseTo(200);
  });

  it('fixed + flexible + discretionary + untagged == total expenses', async () => {
    await insertCat('Rent', 'fixed');
    await insertCat('Food & Drink', 'flexible');
    await insertCat('Entertainment', 'discretionary');
    await insertTx({ amount: 1500, category: 'Rent' });
    await insertTx({ amount: 300, category: 'Food & Drink' });
    await insertTx({ amount: 100, category: 'Entertainment' });
    await insertTx({ amount: 200, category: 'Misc' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    const total = s.fixed + s.flexible + s.discretionary + s.untagged;
    expect(total).toBeCloseTo(2100);
  });

  it('excludes hidden categories', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertCat('Transfer', 'fixed');
    await insertTx({ amount: 500, category: 'Transfer' });
    await insertTx({ amount: 100, category: 'Shopping' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
    expect(s.untagged).toBeCloseTo(100);
  });

  it('excludes pending transactions', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ amount: 1500, category: 'Rent', pending: 1 });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
  });

  it('excludes ignored transactions', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ amount: 1500, category: 'Rent', ignored: 1 });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
  });

  it('respects date range', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ date: '2025-01-15', amount: 1500, category: 'Rent' });
    await insertTx({ date: '2024-12-15', amount: 9999, category: 'Rent' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBeCloseTo(1500);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRangeSummary with accountId', () => {
  it('filters to the given account', async () => {
    await insertTx({ amount: 100, category: 'Shopping', accountId: 'acct1' });
    await insertTx({ amount: 200, category: 'Dining',   accountId: 'acct2' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31', { accounts: ['acct1'] });
    expect(s.expenses).toBeCloseTo(100);
    expect(s.byCategory).toHaveLength(1);
    expect(s.byCategory[0].category).toBe('Shopping');
  });

  it('returns zeros when account has no transactions in range', async () => {
    await insertTx({ amount: 100, accountId: 'acct2' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31', { accounts: ['acct1'] });
    expect(s.expenses).toBe(0);
    expect(s.income).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getMerchantSummary', () => {
  it('returns merchants ranked by net spend with counts and percentages', async () => {
    await insertTx({ amount: 120, category: 'Food & Drink', name: 'Blue Bottle' });
    await insertTx({ amount: 30, category: 'Food & Drink', name: 'Blue Bottle' });
    await insertTx({ amount: 50, category: 'Food & Drink', name: 'Chipotle' });

    const rows = await getMerchantSummary('Food & Drink', '2025-01-01', '2025-01-31');
    expect(rows).toHaveLength(2);
    expect(rows[0].merchant).toBe('Blue Bottle');
    expect(rows[0].total).toBeCloseTo(150);
    expect(rows[0].count).toBe(2);
    expect(rows[0].pct).toBeCloseTo(0.75);
    expect(rows[1].merchant).toBe('Chipotle');
    expect(rows[1].total).toBeCloseTo(50);
    expect(rows[1].count).toBe(1);
    expect(rows[1].pct).toBeCloseTo(0.25);
  });

  it('uses display_name when available and excludes non-positive net merchants', async () => {
    await insertTx({ amount: 100, category: 'Travel', name: 'LYFT *TRIP', displayName: 'Lyft' });
    await insertTx({ amount: -40, category: 'Travel', name: 'LYFT *REFUND', displayName: 'Lyft' });
    await insertTx({ amount: 20, category: 'Travel', name: 'Refund-only merchant' });
    await insertTx({ amount: -30, category: 'Travel', name: 'Refund-only merchant' });

    const rows = await getMerchantSummary('Travel', '2025-01-01', '2025-01-31');
    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe('Lyft');
    expect(rows[0].total).toBeCloseTo(60);
    expect(rows[0].pct).toBeCloseTo(1);
  });

  it('respects account filter and excludes hidden/pending/ignored rows', async () => {
    await db.execute({ sql: "INSERT INTO hidden_categories VALUES (?)", args: ['Transfer'] });
    await insertTx({ amount: 90, category: 'Food', name: 'A', accountId: 'acct1' });
    await insertTx({ amount: 110, category: 'Food', name: 'B', accountId: 'acct2' });
    await insertTx({ amount: 200, category: 'Food', name: 'C', accountId: 'acct1', pending: 1 });
    await insertTx({ amount: 200, category: 'Food', name: 'D', accountId: 'acct1', ignored: 1 });
    await insertTx({ amount: 500, category: 'Transfer', name: 'E', accountId: 'acct1' });

    const rows = await getMerchantSummary('Food', '2025-01-01', '2025-01-31', { accounts: ['acct1'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe('A');
    expect(rows[0].total).toBeCloseTo(90);
  });

  it('uses merchant_name as display when display_name is null', async () => {
    await insertTx({ amount: 80, category: 'Food & Drink', name: 'STARBUCKS #12345', merchantName: 'Starbucks' });
    const rows = await getMerchantSummary('Food & Drink', '2025-01-01', '2025-01-31');
    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toBe('Starbucks');
  });

  it('prefers display_name over merchant_name', async () => {
    await insertTx({ amount: 50, category: 'Food & Drink', name: 'LYFT *TRIP', merchantName: 'Lyft Technologies', displayName: 'Lyft' });
    const rows = await getMerchantSummary('Food & Drink', '2025-01-01', '2025-01-31');
    expect(rows[0].merchant).toBe('Lyft');
  });

  it('falls back to raw name when both display_name and merchant_name are null', async () => {
    await insertTx({ amount: 60, category: 'Food & Drink', name: 'CORNER BAKERY' });
    const rows = await getMerchantSummary('Food & Drink', '2025-01-01', '2025-01-31');
    expect(rows[0].merchant).toBe('CORNER BAKERY');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getSearchFilteredData merchant_name fallback', () => {
  it('matches search against merchant_name when display_name is null', async () => {
    await insertTx({ amount: 40, category: 'Shopping', name: 'AMZN MKTP US*12345', merchantName: 'Amazon' });
    await insertTx({ amount: 20, category: 'Shopping', name: 'TARGET 0123' });

    const { summary } = await getSearchFilteredData('2025-01-01', '2025-01-31', 'Amazon');
    expect(summary.expenses).toBeCloseTo(40);
  });

  it('does not match raw name when merchant_name overrides the display', async () => {
    // The raw name should not be searchable once merchant_name overrides it.
    await insertTx({ amount: 40, category: 'Shopping', name: 'AMZN MKTP US*12345', merchantName: 'Amazon' });

    const { summary: byRaw } = await getSearchFilteredData('2025-01-01', '2025-01-31', 'AMZN');
    expect(byRaw.expenses).toBe(0);

    const { summary: byMerchant } = await getSearchFilteredData('2025-01-01', '2025-01-31', 'Amazon');
    expect(byMerchant.expenses).toBeCloseTo(40);
  });

  it('still matches display_name when both are set', async () => {
    await insertTx({ amount: 30, category: 'Travel', name: 'LYFT *RIDE', merchantName: 'Lyft Technologies', displayName: 'Lyft' });

    const { summary } = await getSearchFilteredData('2025-01-01', '2025-01-31', 'Lyft');
    expect(summary.expenses).toBeCloseTo(30);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getFlexSummary with accountId', () => {
  async function insertCat(name: string, flexibility: string) {
    await db.execute({ sql: 'INSERT INTO categories (name, flexibility) VALUES (?, ?)', args: [name, flexibility] });
  }

  it('filters to the given account', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ amount: 1500, category: 'Rent', accountId: 'acct1' });
    await insertTx({ amount: 999,  category: 'Rent', accountId: 'acct2' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31', { accounts: ['acct1'] });
    expect(s.fixed).toBeCloseTo(1500);
  });

  it('returns zeros when account has no transactions', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ amount: 1500, category: 'Rent', accountId: 'acct2' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31', { accounts: ['acct1'] });
    expect(s.fixed).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRecentTransactions', () => {
  it('returns empty array when no transactions', async () => {
    expect(await getRecentTransactions()).toHaveLength(0);
  });

  it('returns transactions ordered by date descending', async () => {
    await insertTx({ date: '2025-01-01', amount: 10 });
    await insertTx({ date: '2025-01-15', amount: 20 });
    await insertTx({ date: '2025-01-10', amount: 30 });
    const txs = await getRecentTransactions();
    expect(txs[0].date).toBe('2025-01-15');
    expect(txs[1].date).toBe('2025-01-10');
    expect(txs[2].date).toBe('2025-01-01');
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 15; i++) await insertTx({ amount: i });
    expect(await getRecentTransactions(5)).toHaveLength(5);
    expect(await getRecentTransactions(10)).toHaveLength(10);
  });

  it('excludes pending transactions', async () => {
    await insertTx({ amount: 100, pending: 1 });
    await insertTx({ amount: 200, pending: 0 });
    const txs = await getRecentTransactions();
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTransactions — txType filter', () => {
  it('income returns only negative-amount transactions', async () => {
    await insertTx({ amount: -500, category: 'Income' });
    await insertTx({ amount: 100,  category: 'Shopping' });
    const rows = await getTransactions({ txType: 'income' });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-500);
  });

  it('income excludes hidden categories', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ amount: -500, category: 'Income' });
    await insertTx({ amount: -200, category: 'Transfer' });
    const rows = await getTransactions({ txType: 'income' });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Income');
  });

  it('expenses returns only positive-amount transactions', async () => {
    await insertTx({ amount: 100,  category: 'Shopping' });
    await insertTx({ amount: -500, category: 'Income' });
    const rows = await getTransactions({ txType: 'expenses' });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(100);
  });

  it('expenses excludes hidden categories', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ amount: 100, category: 'Shopping' });
    await insertTx({ amount: 200, category: 'Transfer' });
    const rows = await getTransactions({ txType: 'expenses' });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Shopping');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTransactions — flex filter', () => {
  beforeEach(async () => {
    await db.execute("INSERT INTO categories (name, flexibility) VALUES ('Rent', 'fixed')");
    await db.execute("INSERT INTO categories (name, flexibility) VALUES ('Grocery', 'flexible')");
    await db.execute("INSERT INTO categories (name, flexibility) VALUES ('Dining', 'discretionary')");
  });

  it('returns only transactions in categories with the given flex tier', async () => {
    await insertTx({ amount: 1500, category: 'Rent' });
    await insertTx({ amount: 200,  category: 'Grocery' });
    await insertTx({ amount: 50,   category: 'Dining' });
    await insertTx({ amount: 100,  category: 'Shopping' }); // no flex tier
    const fixed = await getTransactions({ flex: 'fixed' });
    expect(fixed).toHaveLength(1);
    expect(fixed[0].category).toBe('Rent');
  });

  it('works for all three tiers', async () => {
    await insertTx({ amount: 1500, category: 'Rent' });
    await insertTx({ amount: 200,  category: 'Grocery' });
    await insertTx({ amount: 50,   category: 'Dining' });
    expect((await getTransactions({ flex: 'fixed' })).map((r) => r.category)).toEqual(['Rent']);
    expect((await getTransactions({ flex: 'flexible' })).map((r) => r.category)).toEqual(['Grocery']);
    expect((await getTransactions({ flex: 'discretionary' })).map((r) => r.category)).toEqual(['Dining']);
  });

  it('excludes categories with no flex tier', async () => {
    await insertTx({ amount: 100, category: 'Shopping' });
    expect(await getTransactions({ flex: 'fixed' })).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('hasAccounts', () => {
  it('returns false when no accounts linked', async () => {
    await db.execute('DELETE FROM plaid_items');
    expect(await hasAccounts()).toBe(false);
  });

  it('returns true when at least one account is linked', async () => {
    await db.execute({
      sql: "INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item1', 'tok_abc', 'Chase')",
      args: [],
    });
    expect(await hasAccounts()).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getLastSyncedAt', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM plaid_items');
  });

  it('returns null when no plaid_items exist', async () => {
    expect(await getLastSyncedAt()).toBeNull();
  });

  it('returns null when items exist but last_synced_at is unset', async () => {
    await db.execute({
      sql: "INSERT INTO plaid_items (item_id, access_token) VALUES ('i1', 'tok')",
      args: [],
    });
    expect(await getLastSyncedAt()).toBeNull();
  });

  it('returns the timestamp when one item has been synced', async () => {
    const ts = Date.now();
    await db.execute({
      sql: "INSERT INTO plaid_items (item_id, access_token, last_synced_at) VALUES ('i1', 'tok', ?)",
      args: [ts],
    });
    expect(await getLastSyncedAt()).toBe(ts);
  });

  it('returns the maximum last_synced_at across multiple items', async () => {
    const older = Date.now() - 60_000;
    const newer = Date.now();
    await db.execute({
      sql: "INSERT INTO plaid_items (item_id, access_token, last_synced_at) VALUES ('i1', 'tok1', ?)",
      args: [older],
    });
    await db.execute({
      sql: "INSERT INTO plaid_items (item_id, access_token, last_synced_at) VALUES ('i2', 'tok2', ?)",
      args: [newer],
    });
    expect(await getLastSyncedAt()).toBe(newer);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getOwnerRows', () => {
  const RANGE = ['2025-01-01', '2025-01-31'] as const;
  const addAccount = (id: string, owner: string | null) =>
    db.execute({
      sql: "INSERT INTO accounts (id, name, type, owner) VALUES (?, ?, 'depository', ?)",
      args: [id, id, owner],
    });

  it('sums expenses per owner, sorted by spend descending', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', 'Partner');
    await insertTx({ accountId: 'a1', amount: 100 });
    await insertTx({ accountId: 'a1', amount: 50 });
    await insertTx({ accountId: 'a2', amount: 200 });
    const rows = await getOwnerRows(...RANGE);
    expect(rows).toEqual([
      { owner: 'Partner', spending: 200 },
      { owner: 'Mark', spending: 150 },
    ]);
  });

  it('buckets accounts with no owner under Unassigned', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', null);
    await addAccount('a3', '   '); // whitespace-only owner counts as unassigned
    await insertTx({ accountId: 'a1', amount: 100 });
    await insertTx({ accountId: 'a2', amount: 75 });
    await insertTx({ accountId: 'a3', amount: 25 });
    const rows = await getOwnerRows(...RANGE);
    expect(rows.find((r) => r.owner === 'Unassigned')?.spending).toBe(100);
  });

  it('lists an owned account even when it has no spend this period (zero row)', async () => {
    await addAccount('a1', 'Mark');
    const rows = await getOwnerRows(...RANGE);
    expect(rows).toEqual([{ owner: 'Mark', spending: 0 }]);
  });

  it('returns no rows when there are no accounts', async () => {
    await insertTx({ amount: 100 }); // orphan tx, no account row
    expect(await getOwnerRows(...RANGE)).toEqual([]);
  });

  it('excludes income, pending, ignored, hidden categories, and out-of-range txns', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await addAccount('a1', 'Mark');
    await insertTx({ accountId: 'a1', amount: 100 });                      // counts
    await insertTx({ accountId: 'a1', amount: -500 });                     // income, excluded
    await insertTx({ accountId: 'a1', amount: 40, pending: 1 });           // pending, excluded
    await insertTx({ accountId: 'a1', amount: 40, ignored: 1 });           // ignored, excluded
    await insertTx({ accountId: 'a1', amount: 40, category: 'Transfer' }); // hidden, excluded
    await insertTx({ accountId: 'a1', amount: 999, date: '2024-12-31' });  // out of range, excluded
    const rows = await getOwnerRows(...RANGE);
    expect(rows).toEqual([{ owner: 'Mark', spending: 100 }]);
  });
});

describe('excluded accounts', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM accounts');
    await db.execute('DELETE FROM balance_history');
    // One counted brokerage, one excluded 529 — same balance.
    await db.execute({ sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES ('brk', 'Brokerage', 'investment', 'brokerage', 0)", args: [] });
    await db.execute({ sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES ('529', '529 Plan', 'investment', '529', 1)", args: [] });
    await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('brk', 100000, '2025-01-31')", args: [] });
    await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('529', 60000, '2025-01-31')", args: [] });
  });

  it('drops excluded accounts from getNetWorthHistory totals', async () => {
    const hist = await getNetWorthHistory('month');
    expect(hist).toHaveLength(1);
    expect(hist[0].assets).toBe(100000);     // 529 omitted
    expect(hist[0].net_worth).toBe(100000);
  });

  it('keeps excluded accounts in getAccountsWithBalances (flagged) but out of the history series', async () => {
    const { accounts, history } = await getAccountsWithBalances();
    expect(accounts.map((a) => a.name).sort()).toEqual(['529 Plan', 'Brokerage']);
    expect(accounts.find((a) => a.name === '529 Plan')!.excluded).toBe(true);
    expect(accounts.find((a) => a.name === 'Brokerage')!.excluded).toBe(false);
    // History time series counts only the non-excluded account.
    expect(history.at(-1)!.assets).toBe(100000);
  });

  it('returns the excluded flag from getLinkedAccounts', async () => {
    const linked = await getLinkedAccounts();
    expect(linked.find((a) => a.id === '529')!.excluded).toBe(true);
    expect(linked.find((a) => a.id === 'brk')!.excluded).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getLinkedAccounts — awaiting-first-sync placeholders', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM plaid_items');
    await db.execute('DELETE FROM balance_history');
  });

  const addItem = (itemId: string, institution: string | null, lastSyncedAt: number | null) =>
    db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
      args: [itemId, 'tok', institution, lastSyncedAt],
    });

  const addAccount = (id: string, itemId: string | null, name = id) =>
    db.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
      args: [id, name, itemId],
    });

  it('emits a placeholder for an unsynced item with no accounts rows', async () => {
    await addItem('item-new', 'Capital One', null);
    const rows = await getLinkedAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0].awaitingFirstSync).toBe(true);
    expect(rows[0].institution_name).toBe('Capital One');
    expect(rows[0].name).toBe('Capital One');
    expect(rows[0].id).toBe('item-new');
    expect(rows[0].item_id).toBe('item-new');
    expect(rows[0].item_last_synced_at).toBeNull();
    expect(rows[0].last_synced).toBeNull();
    expect(rows[0].type).toBe('other');
    expect(rows[0].excluded).toBe(false);
  });

  it('names an institution-less item "New institution"', async () => {
    await addItem('item-new', null, null);
    const rows = await getLinkedAccounts();
    expect(rows[0].name).toBe('New institution');
  });

  it('sorts placeholders ahead of real accounts', async () => {
    await addItem('item-new', 'Capital One', null);
    await addItem('item-old', 'Chase', Date.now());
    await addAccount('acct-chase', 'item-old', 'Chase Checking');
    const rows = await getLinkedAccounts();
    expect(rows.map((r) => r.id)).toEqual(['item-new', 'acct-chase']);
  });

  it('emits no placeholder once the item has accounts rows', async () => {
    await addItem('item-old', 'Chase', null);
    await addAccount('acct-chase', 'item-old');
    const rows = await getLinkedAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('acct-chase');
    expect(rows[0].awaitingFirstSync).toBe(false);
  });

  // A sync that completed but whose accountsGet returned nothing stays a silent
  // failure (unchanged behaviour) — it must not be mislabelled "awaiting first
  // sync" forever. Also guards against deleteAccount, which leaves the
  // plaid_items row behind, resurrecting the item as a placeholder.
  it('emits no placeholder for a synced item with no accounts rows', async () => {
    await addItem('item-empty', 'Empty Bank', Date.now());
    expect(await getLinkedAccounts()).toEqual([]);
  });

  // accountsGet landed but the transaction upsert threw, so last_synced_at is
  // still NULL. The real rows should render normally, not be duplicated.
  it('emits only real rows when accounts exist but last_synced_at is NULL', async () => {
    await addItem('item-partial', 'Chase', null);
    await addAccount('acct-partial', 'item-partial');
    const rows = await getLinkedAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0].awaitingFirstSync).toBe(false);
    expect(rows[0].item_last_synced_at).toBeNull();
  });

  it('emits exactly one placeholder for two items, one synced one not', async () => {
    await addItem('item-synced', 'Chase', Date.now());
    await addAccount('acct-chase', 'item-synced');
    await addItem('item-new', 'Capital One', null);
    const rows = await getLinkedAccounts();
    expect(rows.filter((r) => r.awaitingFirstSync).map((r) => r.item_id)).toEqual(['item-new']);
  });

  it('returns item_last_synced_at as a number for Plaid accounts and null for CSV/manual', async () => {
    const ts = Date.now();
    await addItem('item-synced', 'Chase', ts);
    await addAccount('acct-plaid', 'item-synced');
    await addAccount('manual-thing', null);
    const rows = await getLinkedAccounts();
    const plaid = rows.find((r) => r.id === 'acct-plaid')!;
    const manual = rows.find((r) => r.id === 'manual-thing')!;
    expect(typeof plaid.item_last_synced_at).toBe('number');
    expect(plaid.item_last_synced_at).toBe(ts);
    expect(manual.item_last_synced_at).toBeNull();
  });

  // Only CSV import and the demo seeder ever write accounts.institution_name;
  // the Plaid path records it on plaid_items, so every linked account read it
  // back blank. It now falls back to the item's name through the join.
  it('falls back to the item institution when the account row has none', async () => {
    await addItem('item-chase', 'Chase', Date.now());
    await addAccount('acct-plaid', 'item-chase');
    const rows = await getLinkedAccounts();
    expect(rows.find((r) => r.id === 'acct-plaid')!.institution_name).toBe('Chase');
  });

  it('keeps a CSV/manual account own institution, which has no item to inherit from', async () => {
    await db.execute({
      sql: `INSERT INTO accounts (id, name, type, institution_name) VALUES ('csv-1', 'Imported', 'depository', 'Ally')`,
      args: [],
    });
    const rows = await getLinkedAccounts();
    expect(rows.find((r) => r.id === 'csv-1')!.institution_name).toBe('Ally');
  });

  it('prefers the account own institution over the item when both are set', async () => {
    await addItem('item-chase', 'Chase', Date.now());
    await db.execute({
      sql: `INSERT INTO accounts (id, name, type, item_id, institution_name) VALUES ('acct-both', 'A', 'depository', 'item-chase', 'Renamed Bank')`,
      args: [],
    });
    const rows = await getLinkedAccounts();
    expect(rows.find((r) => r.id === 'acct-both')!.institution_name).toBe('Renamed Bank');
  });

  it('leaves institution null when neither the account nor an item supplies one', async () => {
    await addAccount('manual-thing', null);
    const rows = await getLinkedAccounts();
    expect(rows.find((r) => r.id === 'manual-thing')!.institution_name).toBeNull();
  });

  // Defect-4 regression guard: core/sync.ts only writes a balance row when
  // balances.current is non-null, so an account that synced fine but reported no
  // balance has no balance_history at all. It must report its item's sync time
  // rather than reading "not synced" forever.
  it('reports item_last_synced_at for a synced account with zero balance_history rows', async () => {
    const ts = Date.now();
    await addItem('item-synced', 'Chase', ts);
    await addAccount('acct-nobalance', 'item-synced');
    const rows = await getLinkedAccounts();
    expect(rows[0].last_synced).toBeNull();
    expect(rows[0].item_last_synced_at).toBe(ts);
    expect(rows[0].awaitingFirstSync).toBe(false);
  });
});

describe('getNetWorthHistory accountIds filter', () => {
  // Plaid-style IDs: long base64-ish strings that SQLite treats as column names if unquoted.
  const CHECKING_ID = 'BxBXbRRy44Tb64eKQ4E5tz76vBdkVQ7rY7jKz';
  const BROKERAGE_ID = 'vzdd8YqX7oUMn13YOMNphPA6wejQ4mFVnBXNL';

  beforeEach(async () => {
    await db.execute('DELETE FROM accounts');
    await db.execute('DELETE FROM balance_history');
    await db.execute({ sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES (?, 'Checking', 'depository', 'checking', 0)", args: [CHECKING_ID] });
    await db.execute({ sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES (?, 'Brokerage', 'investment', 'brokerage', 0)", args: [BROKERAGE_ID] });
    await db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, 5000, ?)',  args: [CHECKING_ID,  '2025-01-31'] });
    await db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, 80000, ?)', args: [BROKERAGE_ID, '2025-01-31'] });
  });

  it('returns all accounts when no filter is given', async () => {
    const hist = await getNetWorthHistory('month');
    expect(hist).toHaveLength(1);
    expect(hist[0].assets).toBe(85000);
  });

  it('filters to a single account by Plaid-style string id without SQL error', async () => {
    const hist = await getNetWorthHistory('month', [CHECKING_ID]);
    expect(hist).toHaveLength(1);
    expect(hist[0].assets).toBe(5000);
  });

  it('filters to a subset of accounts', async () => {
    const hist = await getNetWorthHistory('month', [BROKERAGE_ID]);
    expect(hist).toHaveLength(1);
    expect(hist[0].assets).toBe(80000);
  });

  it('returns empty when accountIds is an empty array', async () => {
    const hist = await getNetWorthHistory('month', []);
    expect(hist).toHaveLength(0);
  });
});

describe('getLinkedItems', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM plaid_items');
    await db.execute('DELETE FROM accounts');
    await db.execute('DELETE FROM sync_state');
  });

  const addItem = (
    itemId: string,
    over: { institution?: string | null; lastSyncedAt?: number | null; daysRequested?: number | null } = {},
  ) =>
    db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested)
            VALUES (?, 'tok', ?, ?, ?)`,
      args: [itemId, over.institution ?? itemId, over.lastSyncedAt ?? null, over.daysRequested ?? null],
    });

  const addAccount = (id: string, itemId: string | null) =>
    db.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
      args: [id, id, itemId],
    });

  const addCursor = (itemId: string) =>
    db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: [itemId, 'cur'] });

  it('returns one row per item, not per account', async () => {
    await addItem('item-a', { institution: 'Chase' });
    await addAccount('acct-1', 'item-a');
    await addAccount('acct-2', 'item-a');

    const rows = await getLinkedItems();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item_id: 'item-a', institution_name: 'Chase', account_count: 2 });
  });

  it('counts only the accounts belonging to each item', async () => {
    await addItem('item-a');
    await addItem('item-b');
    await addAccount('acct-1', 'item-a');
    await addAccount('acct-2', 'item-b');
    await addAccount('acct-3', 'item-b');
    // A manual account has no item and must not inflate anyone's count.
    await addAccount('manual-house', null);

    const rows = await getLinkedItems();
    expect(rows.map((r) => [r.item_id, r.account_count])).toEqual([['item-a', 1], ['item-b', 2]]);
  });

  it('reports an item with no accounts and no sync as awaiting its first sync', async () => {
    await addItem('item-new', { institution: 'Capital One' });
    const [row] = await getLinkedItems();
    expect(row.awaitingFirstSync).toBe(true);
    expect(row.account_count).toBe(0);
    expect(row.last_synced_at).toBeNull();
  });

  it('does not call an item awaiting first sync once it has accounts', async () => {
    await addItem('item-a');
    await addAccount('acct-1', 'item-a');
    const [row] = await getLinkedItems();
    expect(row.awaitingFirstSync).toBe(false);
  });

  it('does not call an item awaiting first sync once a sync has completed', async () => {
    // deleteAccount leaves plaid_items behind, so a synced item can legitimately
    // have zero accounts — it must not read as "awaiting first sync" forever.
    await addItem('item-a', { lastSyncedAt: 1_770_000_000_000 });
    const [row] = await getLinkedItems();
    expect(row.awaitingFirstSync).toBe(false);
    expect(row.account_count).toBe(0);
    expect(row.last_synced_at).toBe(1_770_000_000_000);
  });

  it('reports whether a sync cursor is stored', async () => {
    await addItem('item-a');
    await addItem('item-b');
    await addCursor('item-a');

    const rows = await getLinkedItems();
    expect(rows.find((r) => r.item_id === 'item-a')!.hasCursor).toBe(true);
    // No cursor means the next sync replays this item's whole history.
    expect(rows.find((r) => r.item_id === 'item-b')!.hasCursor).toBe(false);
  });

  it('carries days_requested through, leaving the pre-column NULL alone', async () => {
    await addItem('item-a', { daysRequested: 730 });
    await addItem('item-b');
    const rows = await getLinkedItems();
    expect(rows.find((r) => r.item_id === 'item-a')!.days_requested).toBe(730);
    expect(rows.find((r) => r.item_id === 'item-b')!.days_requested).toBeNull();
  });

  it('returns nothing when no items are linked', async () => {
    expect(await getLinkedItems()).toEqual([]);
  });
});
