import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
});

import { vi } from 'vitest';
import { db } from '../core/db.js';
import { getDriftWindows } from '../core/dateUtils.js';
import { getCategoryDriftData, getFlexDriftData, getAccountDriftData } from '../core/queries.js';

// ── helpers ────────────────────────────────────────────────────────────────────

const d = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12, 0, 0);

let txId = 0;
const insertTx = (opts: {
  date?: string;
  amount: number;
  category?: string;
  account_id?: string;
  pending?: number;
  ignored?: number;
}) => {
  txId++;
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tx${txId}`,
    opts.account_id ?? 'acct1',
    opts.date ?? '2025-01-15',
    'Test',
    opts.amount,
    opts.category ?? 'Shopping',
    opts.pending ?? 0,
    opts.ignored ?? 0,
  );
};

const insertAcct = (id: string, type = 'depository') => {
  db.prepare('INSERT OR IGNORE INTO accounts (id, name, type) VALUES (?, ?, ?)').run(id, id, type);
};

beforeEach(() => {
  txId = 0;
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM hidden_categories');
  db.exec('DELETE FROM categories');
  db.exec('DELETE FROM accounts');
});

// ── getDriftWindows ────────────────────────────────────────────────────────────

describe('getDriftWindows', () => {
  it('returns null for alltime range', () => {
    expect(getDriftWindows('alltime', d(2025, 1, 1), d(2025, 5, 27))).toBeNull();
  });

  describe('month range — partial month (MTD)', () => {
    // Today = May 27, 2026 → 26 elapsed days from May 1
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
    // March 2026 is complete; today = May 27 2026
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
      // March has 31 days → elapsed=30; Feb 1 + 30 = March 3 > Feb 28 → cap at Feb 28
      expect(w.lastPeriod.to).toBe('2026-02-28');
    });

    it('lastYear is full March 2025', () => {
      const w = getDriftWindows('month', anchor, today)!;
      expect(w.lastYear.from).toBe('2025-03-01');
      expect(w.lastYear.to).toBe('2025-03-31');
    });
  });

  describe('week range', () => {
    // Week May 19–25, 2025; today = May 22 (Wed = 3 days elapsed)
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
      // 364 days before May 19, 2025 = May 20, 2024 (also a Monday)
      expect(w.lastYear.from).toBe('2024-05-20');
    });
  });
});

// ── getCategoryDriftData ───────────────────────────────────────────────────────

describe('getCategoryDriftData', () => {
  const current    = { from: '2026-05-01', to: '2026-05-27' };
  const lastPeriod = { from: '2026-04-01', to: '2026-04-27' };
  const lastYear   = { from: '2025-05-01', to: '2025-05-27' };
  // rolling12: 12 complete months preceding May 2026 (Apr → May 2025), each first 27 days
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

  it('returns empty array when no current-period transactions', () => {
    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('computes deltas correctly against last period and last year', () => {
    insertTx({ date: '2026-05-15', amount: 200, category: 'Food' });  // current
    insertTx({ date: '2026-04-15', amount: 150, category: 'Food' });  // last period
    insertTx({ date: '2025-05-15', amount: 100, category: 'Food' });  // last year

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const food = result.find((r) => r.category === 'Food')!;

    expect(food.current).toBeCloseTo(200);
    expect(food.lastPeriodDelta).toBeCloseTo(50);   // 200 − 150
    expect(food.lastYearDelta).toBeCloseTo(100);    // 200 − 100
  });

  it('delta is positive when current > comparison (more spending)', () => {
    insertTx({ date: '2026-05-15', amount: 300, category: 'Shopping' });
    insertTx({ date: '2026-04-15', amount: 100, category: 'Shopping' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Shopping')!;
    expect(row.lastPeriodDelta).toBeGreaterThan(0);
  });

  it('delta is negative when current < comparison (less spending)', () => {
    insertTx({ date: '2026-05-15', amount: 50, category: 'Dining' });
    insertTx({ date: '2026-04-15', amount: 200, category: 'Dining' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Dining')!;
    expect(row.lastPeriodDelta).toBeLessThan(0);
  });

  it('category with no last-period spending shows delta = current', () => {
    insertTx({ date: '2026-05-15', amount: 100, category: 'NewCat' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'NewCat')!;
    expect(row.lastPeriodDelta).toBeCloseTo(100);  // 100 − 0
  });

  it('avg12m is average of rolling12 totals', () => {
    // Put $120 in each of the 12 rolling windows (one tx per month)
    const months = ['2026-04','2026-03','2026-02','2026-01','2025-12','2025-11',
                    '2025-10','2025-09','2025-08','2025-07','2025-06','2025-05'];
    for (const ym of months) {
      insertTx({ date: `${ym}-15`, amount: 120, category: 'Shopping' });
    }
    insertTx({ date: '2026-05-15', amount: 180, category: 'Shopping' });  // current

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'Shopping')!;
    expect(row.avg12m).toBeCloseTo(120);
    expect(row.avg12mDelta).toBeCloseTo(60);  // 180 − 120
  });

  it('avg12m is 0 when no historical data', () => {
    insertTx({ date: '2026-05-15', amount: 100, category: 'BrandNew' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    const row = result.find((r) => r.category === 'BrandNew')!;
    expect(row.avg12m).toBe(0);
    expect(row.avg12mDelta).toBeCloseTo(100);
  });

  it('excludes hidden categories', () => {
    db.exec("INSERT INTO hidden_categories VALUES ('Transfer')");
    insertTx({ date: '2026-05-15', amount: 500, category: 'Transfer' });
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result.find((r) => r.category === 'Transfer')).toBeUndefined();
    expect(result.find((r) => r.category === 'Food')).toBeDefined();
  });

  it('excludes pending and ignored transactions', () => {
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food', pending: 1 });
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food', ignored: 1 });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('sorts results by current spend descending', () => {
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food' });
    insertTx({ date: '2026-05-15', amount: 300, category: 'Rent' });
    insertTx({ date: '2026-05-15', amount: 50,  category: 'Gas' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result[0].category).toBe('Rent');
    expect(result[1].category).toBe('Food');
    expect(result[2].category).toBe('Gas');
  });

  it('filters by accountId when provided', () => {
    insertAcct('acct1');
    insertAcct('acct2');
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food', account_id: 'acct1' });
    insertTx({ date: '2026-05-15', amount: 200, category: 'Food', account_id: 'acct2' });

    const result = getCategoryDriftData(current, lastPeriod, lastYear, rolling12, 'acct1');
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

  const insertCat = (name: string, flex: string | null) =>
    db.prepare('INSERT INTO categories (name, flexibility) VALUES (?, ?)').run(name, flex);

  beforeEach(() => { db.exec('DELETE FROM categories'); });

  it('returns zero slices for empty database', () => {
    const data = getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    for (const tier of ['fixed', 'flexible', 'discretionary', 'untagged'] as const) {
      expect(data[tier].current).toBe(0);
      expect(data[tier].avg12m).toBe(0);
    }
  });

  it('buckets tiers and computes deltas', () => {
    insertCat('Rent', 'fixed');
    insertTx({ date: '2026-05-15', amount: 1500, category: 'Rent' });  // current fixed
    insertTx({ date: '2026-04-15', amount: 1500, category: 'Rent' });  // last period fixed

    const data = getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    expect(data.fixed.current).toBeCloseTo(1500);
    expect(data.fixed.lastPeriodDelta).toBeCloseTo(0);  // same as last period
  });

  it('computes avg12m across rolling periods', () => {
    insertCat('Dining', 'flexible');
    // rolling12 all use 2025-01-01 to 2025-01-27; put $100 there
    insertTx({ date: '2025-01-15', amount: 100, category: 'Dining' });
    // current: $200
    insertTx({ date: '2026-05-15', amount: 200, category: 'Dining' });

    const data = getFlexDriftData(current, lastPeriod, lastYear, rolling12);
    expect(data.flexible.avg12m).toBeCloseTo(100);
    expect(data.flexible.avg12mDelta).toBeCloseTo(100);  // 200 − 100
  });
});

// ── getAccountDriftData ────────────────────────────────────────────────────────

describe('getAccountDriftData', () => {
  const current    = { from: '2026-05-01', to: '2026-05-27' };
  const lastPeriod = { from: '2026-04-01', to: '2026-04-27' };
  const lastYear   = { from: '2025-05-01', to: '2025-05-27' };
  const rolling12  = Array.from({ length: 12 }, () => ({ from: '2025-01-01', to: '2025-01-27' }));

  it('returns empty array when no accounts', () => {
    const result = getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    expect(result).toHaveLength(0);
  });

  it('computes per-account spending deltas', () => {
    insertAcct('acct1');
    insertTx({ date: '2026-05-15', amount: 300, category: 'Food', account_id: 'acct1' });
    insertTx({ date: '2026-04-15', amount: 200, category: 'Food', account_id: 'acct1' });

    const result = getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'acct1')!;
    expect(acct.current).toBeCloseTo(300);
    expect(acct.lastPeriodDelta).toBeCloseTo(100);  // 300 − 200
  });

  it('excludes Transfer category from account spending', () => {
    insertAcct('acct1');
    insertTx({ date: '2026-05-15', amount: 500, category: 'Transfer', account_id: 'acct1' });
    insertTx({ date: '2026-05-15', amount: 100, category: 'Food',     account_id: 'acct1' });

    const result = getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'acct1')!;
    expect(acct.current).toBeCloseTo(100);  // Transfer excluded
  });

  it('avg12m is 0 when no rolling history', () => {
    insertAcct('newacct');
    insertTx({ date: '2026-05-15', amount: 200, category: 'Food', account_id: 'newacct' });

    const result = getAccountDriftData(current, lastPeriod, lastYear, rolling12);
    const acct = result.find((r) => r.id === 'newacct')!;
    expect(acct.avg12m).toBe(0);
    expect(acct.avg12mDelta).toBeCloseTo(200);
  });
});
