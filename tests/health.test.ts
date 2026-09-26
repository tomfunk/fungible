import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  yearsToFire, coastYears, loadHealthData, getHealthHistory,
  computeFireRunwayMetrics, savingsRateSeverity, runwaySeverity, debtPayoffSeverity,
} from '../core/health.js';
import { BASIS_LABEL } from '../core/dateUtils.js';

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

describe('getHealthHistory', () => {
  beforeEach(async () => {
    await db.execute('DELETE FROM accounts');
    await db.execute('DELETE FROM balance_history');
    await db.execute('DELETE FROM transactions');

    const acct = (id: string, type: string, subtype: string) =>
      db.execute({
        sql: 'INSERT INTO accounts (id, name, type, subtype, excluded) VALUES (?, ?, ?, ?, 0)',
        args: [id, id, type, subtype],
      });
    const bal = (id: string, balance: number, date: string) =>
      db.execute({
        sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)',
        args: [id, balance, date],
      });
    let txId = 0;
    const tx = (date: string, category: string, amount: number) => {
      txId++;
      return db.execute({
        sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
              VALUES (?, 'chk', ?, 'Test', ?, ?, 0, 0)`,
        args: [`htx${txId}`, date, amount, category],
      });
    };

    await acct('chk', 'depository', 'checking');
    await acct('cc', 'credit', 'credit card');

    // Three monthly balance snapshots.
    await bal('chk', 10000, '2025-01-15');
    await bal('chk', 12000, '2025-02-15');
    await bal('chk', 15000, '2025-03-15');
    await bal('cc', 500, '2025-01-15');
    await bal('cc', 700, '2025-02-15');
    await bal('cc', 300, '2025-03-15');

    // Paycheck (inflow, amount negative) and Groceries (outflow, amount positive)
    // spread across the three months, so the trailing-12mo asOf window has to
    // actually bound by period -- not just always reflect all transactions.
    await tx('2025-01-10', 'Paycheck', -3000);
    await tx('2025-02-10', 'Paycheck', -3000);
    await tx('2025-03-10', 'Paycheck', -3000);
    await tx('2025-01-05', 'Groceries', 500);
    await tx('2025-02-05', 'Groceries', 600);
    await tx('2025-03-05', 'Groceries', 700);
  });

  it('returns one row per period, ordered ascending', async () => {
    const rows = await getHealthHistory('month');
    expect(rows.map((r) => r.period)).toEqual(['2025-01', '2025-02', '2025-03']);
  });

  it('bounds the trailing-12mo averages to each period asOf date, not the full range', async () => {
    const rows = await getHealthHistory('month');
    const [jan, feb, mar] = rows;

    // January only sees the Jan 5/10 transactions (asOf = 2025-01-15).
    expect(jan.asOf).toBe('2025-01-15');
    expect(jan.monthlyIncome).toBeCloseTo(3000 / 12);
    expect(jan.avgMonthlyExpenses).toBeCloseTo(500 / 12);

    // February additionally sees the Feb 5/10 transactions.
    expect(feb.asOf).toBe('2025-02-15');
    expect(feb.monthlyIncome).toBeCloseTo(6000 / 12);
    expect(feb.avgMonthlyExpenses).toBeCloseTo(1100 / 12);

    // March sees all six.
    expect(mar.asOf).toBe('2025-03-15');
    expect(mar.monthlyIncome).toBeCloseTo(9000 / 12);
    expect(mar.avgMonthlyExpenses).toBeCloseTo(1800 / 12);
    expect(mar.monthlySavings).toBeCloseTo(9000 / 12 - 1800 / 12);
  });

  it('carries the balance-history snapshot fields per period, matching loadHealthData semantics', async () => {
    const rows = await getHealthHistory('month');
    const feb = rows.find((r) => r.period === '2025-02')!;
    expect(feb.cash).toBe(12000);
    expect(feb.liquid).toBe(12000);   // no brokerage account in this fixture
    expect(feb.retirement).toBe(0);
    expect(feb.totalDebt).toBe(700);
    expect(feb.loanDebt).toBe(0);
    expect(feb.netWorth).toBe(12000 - 700);
  });

  it('tags every row with the trailing-365d basis, same as loadHealthData', async () => {
    const rows = await getHealthHistory('month');
    for (const r of rows) {
      expect(r.basis).toBe('trailing-365d');
      expect(r.basisLabel).toBe(BASIS_LABEL['trailing-365d']);
    }
  });

  it('caps to the most recent N periods when `periods` is given', async () => {
    const rows = await getHealthHistory('month', 2);
    expect(rows.map((r) => r.period)).toEqual(['2025-02', '2025-03']);
  });

  it('applies no minimum-history gating -- a period still gets an average even with less than 12mo of prior data', async () => {
    const rows = await getHealthHistory('month');
    // January has only ~2 weeks of transaction history behind it, yet still
    // reports a (diluted) non-null average, consistent with
    // getTrailing12moAverages' existing no-minimum behavior.
    expect(rows[0].monthlyIncome).not.toBeNull();
    expect(rows[0].monthlyIncome).toBeGreaterThan(0);
  });
});

describe('computeFireRunwayMetrics', () => {
  const base = {
    monthlySpend: 4000,
    withdrawalRatePct: 4.0,
    cash: 20000,
    liquid: 50000,
    totalDebt: 5000,
    monthlySavings: 2000,
    netWorth: 100000,
  };

  it('computes annualSpend and fireNumber from spend and withdrawal rate', () => {
    const m = computeFireRunwayMetrics(base);
    expect(m.annualSpend).toBe(48000);
    expect(m.fireNumber).toBe(1200000); // 48000 / 0.04
  });

  it('computes fireProgress against fireNumber, floored at 0 net worth', () => {
    const m = computeFireRunwayMetrics(base);
    expect(m.fireProgress).toBeCloseTo(100000 / 1200000);
    expect(computeFireRunwayMetrics({ ...base, netWorth: -5000 }).fireProgress).toBe(0);
  });

  it('returns 0 fireProgress when fireNumber is 0 (zero spend)', () => {
    const m = computeFireRunwayMetrics({ ...base, monthlySpend: 0 });
    expect(m.fireNumber).toBe(0);
    expect(m.fireProgress).toBe(0);
  });

  it('computes cash/liquid runway months, 0 when spend is 0', () => {
    const m = computeFireRunwayMetrics(base);
    expect(m.cashRunwayMonths).toBe(5);   // 20000 / 4000
    expect(m.liquidRunwayMonths).toBe(12.5); // 50000 / 4000
    expect(computeFireRunwayMetrics({ ...base, monthlySpend: 0 }).cashRunwayMonths).toBe(0);
  });

  it('computes netCash and remainingDebt (floored at 0)', () => {
    const m = computeFireRunwayMetrics(base);
    expect(m.netCash).toBe(15000);      // 20000 - 5000
    expect(m.remainingDebt).toBe(0);    // cash already covers the debt
    const m2 = computeFireRunwayMetrics({ ...base, cash: 1000, totalDebt: 5000 });
    expect(m2.netCash).toBe(-4000);
    expect(m2.remainingDebt).toBe(4000);
  });

  it('computes debtPayoffMonths, null when monthlySavings is 0', () => {
    const m = computeFireRunwayMetrics({ ...base, cash: 1000, totalDebt: 5000, monthlySavings: 2000 });
    expect(m.debtPayoffMonths).toBe(2); // 4000 remaining / 2000
    expect(computeFireRunwayMetrics({ ...base, monthlySavings: 0 }).debtPayoffMonths).toBeNull();
  });
});

describe('savingsRateSeverity', () => {
  it('is bad below 0%', () => {
    expect(savingsRateSeverity(-5)).toBe('bad');
  });
  it('is caution between 0% and 10%', () => {
    expect(savingsRateSeverity(0)).toBe('caution');
    expect(savingsRateSeverity(9.9)).toBe('caution');
  });
  it('is neutral between 10% and 20%', () => {
    expect(savingsRateSeverity(10)).toBe('neutral');
    expect(savingsRateSeverity(19.9)).toBe('neutral');
  });
  it('is good at 20% and above', () => {
    expect(savingsRateSeverity(20)).toBe('good');
    expect(savingsRateSeverity(50)).toBe('good');
  });
});

describe('runwaySeverity', () => {
  it('is good at or above greenAt', () => {
    expect(runwaySeverity(6, 6, 3)).toBe('good');
    expect(runwaySeverity(10, 6, 3)).toBe('good');
  });
  it('is caution between yellowAt and greenAt', () => {
    expect(runwaySeverity(3, 6, 3)).toBe('caution');
    expect(runwaySeverity(5.9, 6, 3)).toBe('caution');
  });
  it('is bad below yellowAt', () => {
    expect(runwaySeverity(2.9, 6, 3)).toBe('bad');
    expect(runwaySeverity(0, 6, 3)).toBe('bad');
  });
});

describe('debtPayoffSeverity', () => {
  it('is bad when months is null (no surplus to pay off debt)', () => {
    expect(debtPayoffSeverity(null, 6, 24)).toBe('bad');
  });
  it('is good at or below goodAt -- fewer months is better', () => {
    expect(debtPayoffSeverity(0, 6, 24)).toBe('good');
    expect(debtPayoffSeverity(6, 6, 24)).toBe('good');
  });
  it('is caution between goodAt and cautionAt', () => {
    expect(debtPayoffSeverity(6.1, 6, 24)).toBe('caution');
    expect(debtPayoffSeverity(24, 6, 24)).toBe('caution');
  });
  it('is neutral above cautionAt -- not bad, unlike runwaySeverity\'s polarity', () => {
    expect(debtPayoffSeverity(24.1, 6, 24)).toBe('neutral');
    expect(debtPayoffSeverity(100, 6, 24)).toBe('neutral');
  });
});

