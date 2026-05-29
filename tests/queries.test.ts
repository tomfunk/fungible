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
  hasAccounts,
} from '../core/queries.js';

let txId = 0;
async function insertTx(opts: {
  date?: string;
  name?: string;
  amount: number;
  category?: string;
  pending?: number;
  ignored?: number;
  accountId?: string;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `tx${txId}`,
      opts.accountId ?? 'acct1',
      opts.date ?? '2025-01-15',
      opts.name ?? 'Test Transaction',
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

  it('nets refunds within a category before classifying as income/expense', async () => {
    await insertTx({ amount: 1000, category: 'Travel' });
    await insertTx({ amount: -800, category: 'Travel' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(200);
    expect(s.income).toBe(0);
    expect(s.byCategory).toHaveLength(1);
    expect(s.byCategory[0]).toEqual({ category: 'Travel', total: 200 });
  });

  it('categories with net negative total count as income', async () => {
    await insertTx({ amount: 100, category: 'Rewards' });
    await insertTx({ amount: -200, category: 'Rewards' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.income).toBeCloseTo(100);
    expect(s.expenses).toBe(0);
    expect(s.byCategory).toHaveLength(0);
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

  it('nets out refunds before bucketing — no tier inflation (regression)', async () => {
    await insertCat('Travel', 'discretionary');
    await insertTx({ amount: 10000, category: 'Travel' });
    await insertTx({ amount: -8000, category: 'Travel' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBeCloseTo(2000);
    expect(s.fixed).toBe(0);
    expect(s.flexible).toBe(0);
  });

  it('excludes categories where net is negative (refund-heavy categories)', async () => {
    await insertCat('Travel', 'discretionary');
    await insertTx({ amount: 100, category: 'Travel' });
    await insertTx({ amount: -500, category: 'Travel' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBe(0);
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
    const s = await getRangeSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.expenses).toBeCloseTo(100);
    expect(s.byCategory).toHaveLength(1);
    expect(s.byCategory[0].category).toBe('Shopping');
  });

  it('returns zeros when account has no transactions in range', async () => {
    await insertTx({ amount: 100, accountId: 'acct2' });
    const s = await getRangeSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.expenses).toBe(0);
    expect(s.income).toBe(0);
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
    const s = await getFlexSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.fixed).toBeCloseTo(1500);
  });

  it('returns zeros when account has no transactions', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ amount: 1500, category: 'Rent', accountId: 'acct2' });
    const s = await getFlexSummary('2025-01-01', '2025-01-31', 'acct1');
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
