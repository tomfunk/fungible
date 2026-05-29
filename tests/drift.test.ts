import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { getDriftWindows } from '../core/dateUtils.js';
import { getCategoryDriftData, getFlexDriftData, getAccountDriftData } from '../core/queries.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const d = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12, 0, 0);

let txId = 0;
async function insertTx(opts: {
  date?: string;
  amount: number;
  category?: string;
  account_id?: string;
  pending?: number;
  ignored?: number;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `tx${txId}`,
      opts.account_id ?? 'acct1',
      opts.date ?? '2025-01-15',
      'Test',
      opts.amount,
      opts.category ?? 'Shopping',
      opts.pending ?? 0,
      opts.ignored ?? 0,
    ],
  });
}

async function insertAcct(id: string, type = 'depository') {
  await db.execute({
    sql: 'INSERT OR IGNORE INTO accounts (id, name, type) VALUES (?, ?, ?)',
    args: [id, id, type],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM hidden_categories');
  await db.execute('DELETE FROM categories');
  await db.execute('DELETE FROM accounts');
});

// ── getDriftWindows ────────────────────────────────────────────────────────────

describe('getDriftWindows', () => {
  it('returns null for alltime range', () => {
    expect(getDriftWindows('alltime', d(2025, 1, 1), d(2025, 5, 27))).toBeNull();
  });

  describe('month range — partial month (MTD)', () => {
    const anchor = d(2026, 5, 1);
    const today  = d(2026, 5, 27);

    it('caps current window at today', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.current.from).toBe('2026-05-01');
      expect(w.current.to).toBe('2026-05-27');
    });

    it('lastPeriod uses same elapsed days in April', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.lastPeriod.from).toBe('2026-04-01');
      expect(w.lastPeriod.to).toBe('2026-04-27');
    });

    it('lastYear uses same elapsed days in May 2025', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.lastYear.from).toBe('2025-05-01');
      expect(w.lastYear.to).toBe('2025-05-27');
    });

    it('rolling12 has 12 entries, starting from April 2026', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.rolling12).toHaveLength(12);
      expect(w.rolling12[0].from).toBe('2026-04-01');
      expect(w.rolling12[0].to).toBe('2026-04-27');
      expect(w.rolling12[11].from).toBe('2025-05-01');
      expect(w.rolling12[11].to).toBe('2025-05-27');
    });
  });

  describe('month range — complete past month', () => {
    const anchor = d(2026, 3, 1);
    const today  = d(2026, 5, 27);

    it('current window is full March', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.current.from).toBe('2026-03-01');
      expect(w.current.to).toBe('2026-03-31');
    });

    it('lastPeriod is full February (capped at Feb 28)', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.lastPeriod.from).toBe('2026-02-01');
      expect(w.lastPeriod.to).toBe('2026-02-28');
    });

    it('lastYear is full March 2025', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.lastYear.from).toBe('2025-03-01');
      expect(w.lastYear.to).toBe('2025-03-31');
    });
  });

  describe('week range', () => {
    const anchor = d(2025, 5, 19);
    const today  = d(2025, 5, 22);

    it('current window ends at today', () => {
      const w = getDriftWindows('week', anchor, today)!;
      expect(w.current.from).toBe('2025-05-19');
      expect(w.current.to).toBe('2025-05-22');
    });

    it('lastPeriod is May 12–15 (same 3 elapsed days)', () => {
      const w = getDriftWindows('week', anchor, today)!;
      expect(w.lastPeriod.from).toBe('2025-05-12');
      expect(w.lastPeriod.to).toBe('2025-05-15');
    });

    it('lastYear uses 52-week offset to preserve day-of-week', () => {
      const w = getDriftWindows('week', anchor, today)!;
      expect(w.lastYear.from).toBe('2024-05-20');
    });
  });
});

// ── getCategoryDriftData ───────────────────────────────────────────────────────

describe('getCategoryDriftData', () => {
  const current    = { from: '2026-05-01', to: '2026-05-27' };
  const lastPeriod = { from: '2026-04-01', to: '2026-04-27' };
  const lastYear   = { from: '2025-05-01', to: '2025-05-27' };
  const rolling12 = [
    { from: '2026-04-01', to: '2026-04-27' },
    { from: '2026-03-01', to: '2026-03-27' },
    { from: '2026-02-01', to: '2026-02-27' },
    { from: '2026-01-01', to: '2026-01-27' },
    { from: '2025-12-01', to: '2025-12-27' },
    { from: '2025-11-01', to: '2025-11-27' },
    { from: '2025-10-01', to: '2025-10-27' },
    { from: '2025-09-01', to: '2025-09-27' },
    { from: '2025-08-01', to: '2025-08-27' },
    { from: '2025-07-01', to: '2025-07-27' },
    { from: '2025-06-01', to: '2025-06-27' },
    { from: '2025-05-01', to: '2025-05-27' },
  ];

  it('returns empty array when no current-period transactions', async () => {
    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('computes deltas correctly against last period and last year', async () => {
    await insertTx({ date: '2026-05-15', amount: 200, category: 'Food' });
    await insertTx({ date: '2026-04-15', amount: 150, category: 'Food' });
    await insertTx({ date: '2025-05-15', amount: 100, category: 'Food' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const food = result.find((r) => r.category === 'Food')!;

    expect(food.current).toBeCloseTo(200);
    expect(food.lastPeriodDelta).toBeCloseTo(50);
    expect(food.lastYearDelta).toBeCloseTo(100);
  });

  it('delta is positive when current > comparison (more spending)', async () => {
    await insertTx({ date: '2026-05-15', amount: 300, category: 'Shopping' });
    await insertTx({ date: '2026-04-15', amount: 100, category: 'Shopping' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Shopping')!;
    expect(row.lastPeriodDelta).toBeGreaterThan(0);
  });

  it('delta is negative when current < comparison (less spending)', async () => {
    await insertTx({ date: '2026-05-15', amount: 50, category: 'Dining' });
    await insertTx({ date: '2026-04-15', amount: 200, category: 'Dining' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Dining')!;
    expect(row.lastPeriodDelta).toBeLessThan(0);
  });

  it('category with no last-period spending shows delta = current', async () => {
    await insertTx({ date: '2026-05-15', amount: 100, category: 'NewCat' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'NewCat')!;
    expect(row.lastPeriodDelta).toBeCloseTo(100);
  });

  it('avg12m is average of rolling12 totals', async () => {
    const months = ['2026-04','2026-03','2026-02','2026-01','2025-12','2025-11',
                    '2025-10','2025-09','2025-08','2025-07','2025-06','2025-05'];
    for (const ym of months) {
      await insertTx({ date: `${ym}-15`, amount: 120, category: 'Shopping' });
    }
    await insertTx({ date: '2026-05-15', amount: 180, category: 'Shopping' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Shopping')!;
    expect(row.avg12m).toBeCloseTo(120);
    expect(row.avg12mDelta).toBeCloseTo(60);
  });

  it('avg12m is 0 when no historical data', async () => {
    await insertTx({ date: '2026-05-15', amount: 100, category: 'BrandNew' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'BrandNew')!;
    expect(row.avg12m).toBe(0);
    expect(row.avg12mDelta).toBeCloseTo(100);
  });

  it('excludes hidden categories', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ date: '2026-05-15', amount: 500, category: 'Transfer' });
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result.find((r) => r.category === 'Transfer')).toBeUndefined();
    expect(result.find((r) => r.category === 'Food')).toBeDefined();
  });

  it('excludes pending and ignored transactions', async () => {
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food', pending: 1 });
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food', ignored: 1 });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('sorts results by current spend descending', async () => {
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food' });
    await insertTx({ date: '2026-05-15', amount: 300, category: 'Rent' });
    await insertTx({ date: '2026-05-15', amount: 50,  category: 'Gas' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result[0].category).toBe('Rent');
    expect(result[1].category).toBe('Food');
    expect(result[2].category).toBe('Gas');
  });

  it('filters by accountId when provided', async () => {
    await insertAcct('acct1');
    await insertAcct('acct2');
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food', account_id: 'acct1' });
    await insertTx({ date: '2026-05-15', amount: 200, category: 'Food', account_id: 'acct2' });

    const result = await getCategoryDriftData(current, lastPeriod, lastYear, rolling12, 'acct1');
    const row = result.find((r) => r.category === 'Food')!;
    expect(row.current).toBeCloseTo(100);
  });
});

// ── getFlexDriftData ───────────────────────────────────────────────────────────

describe('getFlexDriftData', () => {
  const current    = { from: '2026-05-01', to: '2026-05-27' };
  const lastPeriod = { from: '2026-04-01', to: '2026-04-27' };
  const lastYear   = { from: '2025-05-01', to: '2025-05-27' };
  const rolling12  = Array.from({ length: 12 }, () => ({ from: '2025-01-01', to: '2025-01-27' }));

  async function insertCat(name: string, flex: string | null) {
    await db.execute({ sql: 'INSERT INTO categories (name, flexibility) VALUES (?, ?)', args: [name, flex] });
  }

  beforeEach(async () => {
    await db.execute('DELETE FROM categories');
  });

  it('returns zero slices for empty database', async () => {
    const data = await getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    for (const tier of ['fixed', 'flexible', 'discretionary', 'untagged'] as const) {
      expect(data[tier].current).toBe(0);
      expect(data[tier].avg12m).toBe(0);
    }
  });

  it('buckets tiers and computes deltas', async () => {
    await insertCat('Rent', 'fixed');
    await insertTx({ date: '2026-05-15', amount: 1500, category: 'Rent' });
    await insertTx({ date: '2026-04-15', amount: 1500, category: 'Rent' });

    const data = await getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    expect(data.fixed.current).toBeCloseTo(1500);
    expect(data.fixed.lastPeriodDelta).toBeCloseTo(0);
  });

  it('computes avg12m across rolling periods', async () => {
    await insertCat('Dining', 'flexible');
    await insertTx({ date: '2025-01-15', amount: 100, category: 'Dining' });
    await insertTx({ date: '2026-05-15', amount: 200, category: 'Dining' });

    const data = await getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    expect(data.flexible.avg12m).toBeCloseTo(100);
    expect(data.flexible.avg12mDelta).toBeCloseTo(100);
  });
});

// ── getAccountDriftData ────────────────────────────────────────────────────────

describe('getAccountDriftData', () => {
  const current    = { from: '2026-05-01', to: '2026-05-27' };
  const lastPeriod = { from: '2026-04-01', to: '2026-04-27' };
  const lastYear   = { from: '2025-05-01', to: '2025-05-27' };
  const rolling12  = Array.from({ length: 12 }, () => ({ from: '2025-01-01', to: '2025-01-27' }));

  it('returns empty array when no accounts', async () => {
    const result = await getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('computes per-account spending deltas', async () => {
    await insertAcct('acct1');
    await insertTx({ date: '2026-05-15', amount: 300, category: 'Food', account_id: 'acct1' });
    await insertTx({ date: '2026-04-15', amount: 200, category: 'Food', account_id: 'acct1' });

    const result = await getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'acct1')!;
    expect(acct.current).toBeCloseTo(300);
    expect(acct.lastPeriodDelta).toBeCloseTo(100);
  });

  it('excludes Transfer category from account spending', async () => {
    await insertAcct('acct1');
    await insertTx({ date: '2026-05-15', amount: 500, category: 'Transfer', account_id: 'acct1' });
    await insertTx({ date: '2026-05-15', amount: 100, category: 'Food',     account_id: 'acct1' });

    const result = await getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'acct1')!;
    expect(acct.current).toBeCloseTo(100);
  });

  it('avg12m is 0 when no rolling history', async () => {
    await insertAcct('newacct');
    await insertTx({ date: '2026-05-15', amount: 200, category: 'Food', account_id: 'newacct' });

    const result = await getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'newacct')!;
    expect(acct.avg12m).toBe(0);
    expect(acct.avg12mDelta).toBeCloseTo(200);
  });
});
