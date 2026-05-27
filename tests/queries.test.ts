import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
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
const insertTx = (opts: {
  date?: string;
  name?: string;
  amount: number;
  category?: string;
  pending?: number;
  ignored?: number;
  accountId?: string;
}) => {
  txId++;
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tx${txId}`,
    opts.accountId ?? 'acct1',
    opts.date ?? '2025-01-15',
    opts.name ?? 'Test Transaction',
    opts.amount,
    opts.category ?? 'Shopping',
    opts.pending ?? 0,
    opts.ignored ?? 0,
  );
};

beforeEach(() => {
  txId = 0;
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM hidden_categories');
  db.exec('DELETE FROM categories');
  db.exec('DELETE FROM accounts');
});

// ──────────────────────────────────────────────────────────────────────
describe('getHiddenCategories', () => {
  it('returns empty set when no hidden categories', () => {
    expect(getHiddenCategories().size).toBe(0);
  });

  it('returns set of hidden category names', () => {
    db.exec("INSERT INTO hidden_categories VALUES ('Transfer')");
    db.exec("INSERT INTO hidden_categories VALUES ('Loan Payment')");
    const hidden = getHiddenCategories();
    expect(hidden.has('Transfer')).toBe(true);
    expect(hidden.has('Loan Payment')).toBe(true);
    expect(hidden.has('Shopping')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRangeSummary', () => {
  it('returns zeros for empty database', () => {
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.income).toBe(0);
    expect(s.expenses).toBe(0);
    expect(s.net).toBe(0);
    expect(s.byCategory).toHaveLength(0);
  });

  it('separates expenses (positive amounts) from income (negative amounts)', () => {
    insertTx({ amount: 100, category: 'Shopping' });
    insertTx({ amount: -200, category: 'Income' });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
    expect(s.income).toBeCloseTo(200);
    expect(s.net).toBeCloseTo(100); // income - expenses = 200 - 100 = 100
  });

  it('only includes dates within the range', () => {
    insertTx({ date: '2025-01-01', amount: 50, category: 'Shopping' });
    insertTx({ date: '2025-01-31', amount: 50, category: 'Shopping' });
    insertTx({ date: '2024-12-31', amount: 999, category: 'Shopping' }); // before range
    insertTx({ date: '2025-02-01', amount: 999, category: 'Shopping' }); // after range
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
  });

  it('excludes pending transactions', () => {
    insertTx({ amount: 100, category: 'Shopping', pending: 1 });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBe(0);
  });

  it('excludes ignored transactions', () => {
    insertTx({ amount: 100, category: 'Shopping', ignored: 1 });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBe(0);
  });

  it('excludes hidden categories', () => {
    db.exec("INSERT INTO hidden_categories VALUES ('Transfer')");
    insertTx({ amount: 500, category: 'Transfer' });
    insertTx({ amount: 100, category: 'Shopping' });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(100);
  });

  it('nets refunds within a category before classifying as income/expense', () => {
    // Travel: $1000 out, $800 refund → net $200 expense
    insertTx({ amount: 1000, category: 'Travel' });
    insertTx({ amount: -800, category: 'Travel' });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(200);
    expect(s.income).toBe(0);
    expect(s.byCategory).toHaveLength(1);
    expect(s.byCategory[0]).toEqual({ category: 'Travel', total: 200 });
  });

  it('categories with net negative total count as income', () => {
    // Category receives more refunds than charges
    insertTx({ amount: 100, category: 'Rewards' });
    insertTx({ amount: -200, category: 'Rewards' });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.income).toBeCloseTo(100); // net is -100 → abs = 100 income
    expect(s.expenses).toBe(0);
    expect(s.byCategory).toHaveLength(0); // not an expense category
  });

  it('aggregates multiple categories correctly', () => {
    insertTx({ amount: 100, category: 'Food & Drink' });
    insertTx({ amount: 200, category: 'Shopping' });
    insertTx({ amount: -500, category: 'Income' });
    const s = getRangeSummary('2025-01-01', '2025-01-31');
    expect(s.expenses).toBeCloseTo(300);
    expect(s.income).toBeCloseTo(500);
    expect(s.byCategory).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getFlexSummary', () => {
  const insertCat = (name: string, flexibility: string | null) => {
    db.prepare('INSERT INTO categories (name, flexibility) VALUES (?, ?)').run(name, flexibility);
  };

  beforeEach(() => {
    db.exec('DELETE FROM categories');
  });

  it('returns zeros for empty database', () => {
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
    expect(s.flexible).toBe(0);
    expect(s.discretionary).toBe(0);
    expect(s.untagged).toBe(0);
  });

  it('buckets spending by flexibility tier', () => {
    insertCat('Rent', 'fixed');
    insertCat('Food & Drink', 'flexible');
    insertCat('Entertainment', 'discretionary');
    insertTx({ amount: 1500, category: 'Rent' });
    insertTx({ amount: 300, category: 'Food & Drink' });
    insertTx({ amount: 100, category: 'Entertainment' });
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBeCloseTo(1500);
    expect(s.flexible).toBeCloseTo(300);
    expect(s.discretionary).toBeCloseTo(100);
    expect(s.untagged).toBe(0);
  });

  it('puts spending with no flexibility tag in untagged', () => {
    insertCat('Mystery', null);
    insertTx({ amount: 50, category: 'Mystery' });
    insertTx({ amount: 75, category: 'UnknownCat' }); // not in categories table at all
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.untagged).toBeCloseTo(125);
  });

  it('nets out refunds before bucketing — no tier inflation (regression)', () => {
    // This is the bug that caused percentages to sum to >100%.
    // Travel: $10,000 charge, $8,000 refund → net $2,000 → discretionary += $2,000
    // NOT: discretionary += $10,000 (gross positive transactions)
    insertCat('Travel', 'discretionary');
    insertTx({ amount: 10000, category: 'Travel' });
    insertTx({ amount: -8000, category: 'Travel' });
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBeCloseTo(2000);
    expect(s.fixed).toBe(0);
    expect(s.flexible).toBe(0);
  });

  it('excludes categories where net is negative (refund-heavy categories)', () => {
    insertCat('Travel', 'discretionary');
    insertTx({ amount: 100, category: 'Travel' });
    insertTx({ amount: -500, category: 'Travel' }); // net negative → not an expense
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.discretionary).toBe(0);
  });

  it('fixed + flexible + discretionary + untagged == total expenses', () => {
    insertCat('Rent', 'fixed');
    insertCat('Food & Drink', 'flexible');
    insertCat('Entertainment', 'discretionary');
    insertTx({ amount: 1500, category: 'Rent' });
    insertTx({ amount: 300, category: 'Food & Drink' });
    insertTx({ amount: 100, category: 'Entertainment' });
    insertTx({ amount: 200, category: 'Misc' }); // untagged
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    const total = s.fixed + s.flexible + s.discretionary + s.untagged;
    expect(total).toBeCloseTo(2100);
  });

  it('excludes hidden categories', () => {
    db.exec("INSERT INTO hidden_categories VALUES ('Transfer')");
    insertCat('Transfer', 'fixed');
    insertTx({ amount: 500, category: 'Transfer' });
    insertTx({ amount: 100, category: 'Shopping' });
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0); // Transfer is hidden
    expect(s.untagged).toBeCloseTo(100); // Shopping has no flex tag
  });

  it('excludes pending transactions', () => {
    insertCat('Rent', 'fixed');
    insertTx({ amount: 1500, category: 'Rent', pending: 1 });
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
  });

  it('excludes ignored transactions', () => {
    insertCat('Rent', 'fixed');
    insertTx({ amount: 1500, category: 'Rent', ignored: 1 });
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBe(0);
  });

  it('respects date range', () => {
    insertCat('Rent', 'fixed');
    insertTx({ date: '2025-01-15', amount: 1500, category: 'Rent' });
    insertTx({ date: '2024-12-15', amount: 9999, category: 'Rent' }); // out of range
    const s = getFlexSummary('2025-01-01', '2025-01-31');
    expect(s.fixed).toBeCloseTo(1500);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRangeSummary with accountId', () => {
  it('filters to the given account', () => {
    insertTx({ amount: 100, category: 'Shopping', accountId: 'acct1' });
    insertTx({ amount: 200, category: 'Dining',   accountId: 'acct2' });
    const s = getRangeSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.expenses).toBeCloseTo(100);
    expect(s.byCategory).toHaveLength(1);
    expect(s.byCategory[0].category).toBe('Shopping');
  });

  it('returns zeros when account has no transactions in range', () => {
    insertTx({ amount: 100, accountId: 'acct2' });
    const s = getRangeSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.expenses).toBe(0);
    expect(s.income).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getFlexSummary with accountId', () => {
  const insertCat = (name: string, flexibility: string) =>
    db.prepare('INSERT INTO categories (name, flexibility) VALUES (?, ?)').run(name, flexibility);

  it('filters to the given account', () => {
    insertCat('Rent', 'fixed');
    insertTx({ amount: 1500, category: 'Rent', accountId: 'acct1' });
    insertTx({ amount: 999,  category: 'Rent', accountId: 'acct2' });
    const s = getFlexSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.fixed).toBeCloseTo(1500);
  });

  it('returns zeros when account has no transactions', () => {
    insertCat('Rent', 'fixed');
    insertTx({ amount: 1500, category: 'Rent', accountId: 'acct2' });
    const s = getFlexSummary('2025-01-01', '2025-01-31', 'acct1');
    expect(s.fixed).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getRecentTransactions', () => {
  it('returns empty array when no transactions', () => {
    expect(getRecentTransactions()).toHaveLength(0);
  });

  it('returns transactions ordered by date descending', () => {
    insertTx({ date: '2025-01-01', amount: 10 });
    insertTx({ date: '2025-01-15', amount: 20 });
    insertTx({ date: '2025-01-10', amount: 30 });
    const txs = getRecentTransactions();
    expect(txs[0].date).toBe('2025-01-15');
    expect(txs[1].date).toBe('2025-01-10');
    expect(txs[2].date).toBe('2025-01-01');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 15; i++) insertTx({ amount: i });
    expect(getRecentTransactions(5)).toHaveLength(5);
    expect(getRecentTransactions(10)).toHaveLength(10);
  });

  it('excludes pending transactions', () => {
    insertTx({ amount: 100, pending: 1 });
    insertTx({ amount: 200, pending: 0 });
    const txs = getRecentTransactions();
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('hasAccounts', () => {
  it('returns false when no accounts linked', () => {
    db.exec('DELETE FROM plaid_items');
    expect(hasAccounts()).toBe(false);
  });

  it('returns true when at least one account is linked', () => {
    db.prepare(
      "INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item1', 'tok_abc', 'Chase')"
    ).run();
    expect(hasAccounts()).toBe(true);
  });
});
