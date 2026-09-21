import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { getPeriodTotals, getSearchPeriodTotals, getSearchMatchingPeriods, type View } from '../core/trends.js';

let seq = 0;
/** Sign convention: positive amount = money out, negative = money in. */
async function tx(opts: { date: string; amount: number; category: string; name?: string }) {
  seq++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
          VALUES (?, 'acct1', ?, ?, ?, ?, 0, 0)`,
    args: [`tx${seq}`, opts.date, opts.name ?? 'Test', opts.amount, opts.category],
  });
}

const view = (over: Partial<View>): View =>
  ({ mode: 'expenses', category: null, flex: null, label: '', ...over });

const monthTotal = async (v: View, from: string) =>
  (await getPeriodTotals(v, 'month')).find((p) => p.from === from)?.total ?? 0;

beforeEach(async () => {
  seq = 0;
  for (const t of ['transactions', 'categories', 'hidden_categories']) await db.execute(`DELETE FROM ${t}`);
});

describe('getPeriodTotals — inflows net against outflows per category', () => {
  // The real case this guards: a group trip fronted on one card and repaid by
  // friends. Both legs are categorized Travel, so the month's travel spend is
  // the difference, not the gross charge.
  beforeEach(async () => {
    await tx({ date: '2026-04-03', amount: 4000, category: 'Travel', name: 'Amtrak' });
    await tx({ date: '2026-04-16', amount: 6387.31, category: 'Travel', name: 'Amtrak' });
    await tx({ date: '2026-04-17', amount: -1835.10, category: 'Travel', name: 'Venmo' });
    await tx({ date: '2026-04-20', amount: -2080.52, category: 'Travel', name: 'Venmo' });
    await tx({ date: '2026-04-29', amount: -4000, category: 'Travel', name: 'Venmo' });
  });

  it('category mode reports net spend, not gross outflow', async () => {
    const total = await monthTotal(view({ mode: 'category', category: 'Travel' }), '2026-04-01');
    expect(total).toBeCloseTo(2471.69, 2); // 10387.31 out − 7915.62 back
  });

  it('expenses mode nets the same inflows', async () => {
    const total = await monthTotal(view({ mode: 'expenses' }), '2026-04-01');
    expect(total).toBeCloseTo(2471.69, 2);
  });

  it('flex mode nets the same inflows', async () => {
    await db.execute("INSERT INTO categories (name, flexibility) VALUES ('Travel', 'discretionary')");
    const total = await monthTotal(view({ mode: 'flex', flex: 'discretionary' }), '2026-04-01');
    expect(total).toBeCloseTo(2471.69, 2);
  });

  it('income mode does not count the repayments as income', async () => {
    // Travel nets out as spending, so the Venmo legs are already consumed there.
    // Counting them again here would inflate both sides of the same month.
    const total = await monthTotal(view({ mode: 'income' }), '2026-04-01');
    expect(total).toBe(0);
  });

  it('net mode reconciles with the expenses and income views', async () => {
    const rows = await getPeriodTotals(view({ mode: 'net' }), 'month');
    const april = rows.find((p) => p.from === '2026-04-01');
    const expenses = await monthTotal(view({ mode: 'expenses' }), '2026-04-01');
    const income   = await monthTotal(view({ mode: 'income' }), '2026-04-01');

    expect(april?.expenses).toBeCloseTo(expenses, 2);
    expect(april?.income).toBeCloseTo(income, 2);
    expect(april?.total).toBeCloseTo(income - expenses, 2);
  });
});

describe('getPeriodTotals — netting edge cases', () => {
  it('a category that nets negative drops out rather than offsetting other categories', async () => {
    // A refund larger than the month's spend in that category is income, not a
    // discount on groceries.
    await tx({ date: '2026-05-10', amount: 100, category: 'Shopping' });
    await tx({ date: '2026-05-11', amount: -400, category: 'Shopping' });
    await tx({ date: '2026-05-12', amount: 250, category: 'Grocery' });

    const total = await monthTotal(view({ mode: 'expenses' }), '2026-05-01');
    expect(total).toBe(250); // Grocery only; Shopping's −300 does not reduce it
  });

  it('Uncategorized keeps outflows and inflows separate', async () => {
    // Uncategorized legitimately mixes an un-ruled paycheck with real spending,
    // so netting there would erase the spending. Matches summarizeBuckets.
    await tx({ date: '2026-05-10', amount: 300, category: 'Uncategorized' });
    await tx({ date: '2026-05-11', amount: -5000, category: 'Uncategorized', name: 'Paycheck' });

    const total = await monthTotal(view({ mode: 'expenses' }), '2026-05-01');
    expect(total).toBe(300);
  });

  it('net mode reports the netted category, not both gross sides', async () => {
    await tx({ date: '2026-06-01', amount: 1000, category: 'Travel' });
    await tx({ date: '2026-06-02', amount: -400, category: 'Travel' });

    const rows = await getPeriodTotals(view({ mode: 'net' }), 'month');
    const june = rows.find((p) => p.from === '2026-06-01');
    expect(june?.expenses).toBeCloseTo(600, 2); // not 1000
    expect(june?.income).toBe(0);               // not 400
    expect(june?.total).toBeCloseTo(-600, 2);
  });

  it('a category that nets negative shows up as income across all three views', async () => {
    // A tax refund exceeding the year's tax payments is genuinely income; it must
    // land on the income side rather than discounting other spending.
    await tx({ date: '2026-07-01', amount: 500, category: 'Taxes' });
    await tx({ date: '2026-07-02', amount: -2000, category: 'Taxes' });
    await tx({ date: '2026-07-03', amount: 300, category: 'Grocery' });

    const rows = await getPeriodTotals(view({ mode: 'net' }), 'month');
    const july = rows.find((p) => p.from === '2026-07-01');
    expect(july?.income).toBeCloseTo(1500, 2);
    expect(july?.expenses).toBeCloseTo(300, 2);
    expect(await monthTotal(view({ mode: 'income' }), '2026-07-01')).toBeCloseTo(1500, 2);
    expect(await monthTotal(view({ mode: 'expenses' }), '2026-07-01')).toBeCloseTo(300, 2);
  });

  it('a month with no transactions reports zero, not a missing row', async () => {
    await tx({ date: '2026-04-10', amount: 50, category: 'Grocery' });
    await tx({ date: '2026-06-10', amount: 50, category: 'Grocery' });

    expect(await monthTotal(view({ mode: 'expenses' }), '2026-05-01')).toBe(0);
  });
});

describe('search matching — amount and date (getSearchMatchingPeriods / getSearchPeriodTotals)', () => {
  it('an unsigned amount search matches by displayed magnitude, either direction', async () => {
    await tx({ date: '2026-04-03', amount: 42.50, category: 'Shopping' });  // outflow, displays -$42.50
    await tx({ date: '2026-05-10', amount: -42.50, category: 'Shopping' }); // inflow, displays +$42.50
    await tx({ date: '2026-04-04', amount: 100, category: 'Shopping' });   // distractor

    const { count, periods } = await getSearchMatchingPeriods('42.50', 'month');
    expect(count).toBe(2);
    expect(periods.has('2026-04-01')).toBe(true);
    expect(periods.has('2026-05-01')).toBe(true);
  });

  it('a signed amount search matches only the matching direction', async () => {
    await tx({ date: '2026-04-03', amount: 42.50, category: 'Shopping' });  // outflow, displays -$42.50
    await tx({ date: '2026-04-10', amount: -42.50, category: 'Refund' });   // inflow, displays +$42.50

    expect((await getSearchMatchingPeriods('-42.50', 'month')).count).toBe(1);
    expect((await getSearchMatchingPeriods('+42.50', 'month')).count).toBe(1);
  });

  it('amount search is exact to the cent, not a prefix match', async () => {
    await tx({ date: '2026-04-03', amount: 42.37, category: 'Shopping' });
    expect((await getSearchMatchingPeriods('42', 'month')).count).toBe(0);
  });

  it('a bare M/D date search matches that day across every year', async () => {
    await tx({ date: '2024-03-15', amount: 15, category: 'A' });
    await tx({ date: '2026-03-15', amount: 25, category: 'B' });
    await tx({ date: '2026-03-16', amount: 999, category: 'C' }); // distractor

    const { count, periods } = await getSearchMatchingPeriods('3/15', 'month');
    expect(count).toBe(2);
    expect(periods.has('2024-03-01')).toBe(true);
    expect(periods.has('2026-03-01')).toBe(true);
  });

  it('exact date forms (YYYY-MM-DD, M/D/YYYY) match a single day, not the whole month', async () => {
    await tx({ date: '2026-03-15', amount: 30, category: 'Travel' });
    await tx({ date: '2026-03-16', amount: 99, category: 'Travel' });

    expect((await getSearchMatchingPeriods('2026-03-15', 'month')).count).toBe(1);
    expect((await getSearchMatchingPeriods('3/15/2026', 'month')).count).toBe(1);
  });

  it('whole-month forms (YYYY-MM, "Month YYYY") match every day in that month', async () => {
    await tx({ date: '2026-03-01', amount: 10, category: 'A' });
    await tx({ date: '2026-03-31', amount: 20, category: 'B' });
    await tx({ date: '2026-04-01', amount: 999, category: 'C' }); // distractor

    expect((await getSearchMatchingPeriods('2026-03', 'month')).count).toBe(2);
    expect((await getSearchMatchingPeriods('March 2026', 'month')).count).toBe(2);
  });

  it('getSearchPeriodTotals sums only the matched transactions into their period', async () => {
    await tx({ date: '2026-04-03', amount: 42.50, category: 'Shopping' });
    await tx({ date: '2026-04-10', amount: 100, category: 'Shopping' }); // distractor, must not be summed in

    const rows = await getSearchPeriodTotals('42.50', 'month');
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe('2026-04-01');
    expect(rows[0].expenses).toBeCloseTo(42.50);
  });

  it('a plain-text search still falls back to name matching, unaffected by amount/date parsing', async () => {
    await tx({ date: '2026-04-03', amount: 20, category: 'Shopping', name: 'Trader Joes' });
    await tx({ date: '2026-04-04', amount: 20, category: 'Shopping', name: 'Target' });

    const { count } = await getSearchMatchingPeriods('trader', 'month');
    expect(count).toBe(1);
  });
});
