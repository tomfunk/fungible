import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { yearsToFire, coastYears, loadHealthData } from '../core/health.js';

describe('yearsToFire', () => {
  it('returns 0 when already at or above target', () => {
    expect(yearsToFire(500000, 2000, 500000, 7)).toBe(0);
    expect(yearsToFire(600000, 2000, 500000, 7)).toBe(0);
  });

  it('returns 0 when target is 0 or negative', () => {
    expect(yearsToFire(0, 2000, 0, 7)).toBe(0);
    expect(yearsToFire(100000, 2000, -1, 7)).toBe(0);
  });

  it('returns null when savings will never reach target (zero savings, below target)', () => {
    expect(yearsToFire(0, 0, 1000000, 0)).toBeNull();
  });

  it('returns a reasonable estimate for known values', () => {
    const years = yearsToFire(0, 2000, 600000, 7);
    expect(years).not.toBeNull();
    expect(years!).toBeGreaterThan(5);
    expect(years!).toBeLessThan(50);
  });

  it('handles negative net worth', () => {
    const years = yearsToFire(-50000, 3000, 600000, 7);
    expect(years).not.toBeNull();
    expect(years!).toBeGreaterThan(0);
  });

  it('returns null when 100 years is not enough', () => {
    const years = yearsToFire(0, 1, 10000000000, 0);
    expect(years).toBeNull();
  });
});

describe('coastYears', () => {
  it('returns 0 when net worth already meets fire number', () => {
    expect(coastYears(1000000, 1000000, 7)).toBe(0);
    expect(coastYears(1500000, 1000000, 7)).toBe(0);
  });

  it('returns null when net worth is 0 or negative', () => {
    expect(coastYears(0, 1000000, 7)).toBeNull();
    expect(coastYears(-100000, 1000000, 7)).toBeNull();
  });

  it('returns null when fire number is 0 or negative', () => {
    expect(coastYears(100000, 0, 7)).toBeNull();
    expect(coastYears(100000, -1, 7)).toBeNull();
  });

  it('returns a positive number of years when net worth is below target', () => {
    const years = coastYears(100000, 1000000, 7);
    expect(years).not.toBeNull();
    expect(years!).toBeGreaterThan(0);
  });

  it('returns null for extreme values (over 200 years)', () => {
    expect(coastYears(1, 1000000000, 1)).toBeNull();
  });
});

describe('loadHealthData — loan accounts as liabilities', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM accounts');
    await db.execute('DELETE FROM balance_history');
    await db.execute('DELETE FROM transactions');

    const acct = (id: string, type: string, subtype: string) =>
      db.execute({
        sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES (?, ?, ?, ?, 0)",
        args: [id, id, type, subtype],
      });
    const bal = (id: string, balance: number) =>
      db.execute({
        sql: "INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, '2026-05-20')",
        args: [id, balance],
      });

    await acct('chk', 'depository', 'checking');
    await acct('brk', 'investment', 'brokerage');
    await acct('401k', 'investment', '401k');
    await acct('cc', 'credit', 'credit card');
    await acct('mtg', 'loan', 'mortgage');

    await bal('chk', 40000);    // cash + liquid
    await bal('brk', 150000);   // liquid (taxable brokerage), not cash
    await bal('401k', 500000);  // retirement, not liquid
    await bal('cc', 3000);      // credit liability
    await bal('mtg', 300000);   // loan liability
  });

  it('subtracts both credit and loan balances from net worth', async () => {
    const h = await loadHealthData();
    // assets 40000 + 150000 + 500000 = 690000; liabilities 3000 + 300000 = 303000
    expect(h.netWorth).toBe(387000);
  });

  it('reports loanDebt separately from credit-card debt', async () => {
    const h = await loadHealthData();
    expect(h.totalDebt).toBe(3000);    // credit card only
    expect(h.loanDebt).toBe(300000);   // mortgage, reported on its own
  });

  it('leaves cash and liquid untouched by the loan', async () => {
    const h = await loadHealthData();
    expect(h.cash).toBe(40000);              // depository only
    expect(h.liquid).toBe(190000);           // checking + taxable brokerage
    expect(h.retirement).toBe(500000);       // 401k
  });
});

