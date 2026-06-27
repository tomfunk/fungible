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
  getOwnerRows,
  hasAccounts,
  getTransactions,
  getNetWorthHistory,
  getAccountsWithBalances,
  getLinkedAccounts,
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
