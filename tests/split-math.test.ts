import { describe, it, expect } from 'vitest';
import { computeSplit, ratioOn, monthBounds, type SplitTxRow, type SplitRatio } from '../core/split-math.js';

const NAMES = { self: 'Pat', spouse: 'Alex' };
const RATIOS: SplitRatio[] = [{ startDate: '2026-01-01', selfPct: 60 }];
const TODAY = '2026-11-15';

let seq = 0;
function row(overrides: Partial<SplitTxRow> = {}): SplitTxRow {
  seq++;
  return {
    id: `tx-${seq}`, date: '2026-10-05', amount: 100, owner: 'Pat',
    joint: true, settled: false, pending: false, ignored: false, hidden: false,
    ...overrides,
  };
}

function month(rows: SplitTxRow[], m = '2026-10', ratios = RATIOS, today = TODAY) {
  const found = computeSplit(rows, ratios, NAMES, today).find((x) => x.month === m);
  if (!found) throw new Error(`no summary for ${m}`);
  return found;
}

describe('ratioOn', () => {
  const ratios = [{ startDate: '2026-01-01', selfPct: 60 }, { startDate: '2026-10-15', selfPct: 45 }];
  it('picks the latest ratio starting on or before the date', () => {
    expect(ratioOn('2026-10-14', ratios)?.selfPct).toBe(60);
    expect(ratioOn('2026-10-15', ratios)?.selfPct).toBe(45);
  });
  it('is null before the first ratio', () => {
    expect(ratioOn('2025-12-31', ratios)).toBeNull();
  });
});

describe('monthBounds', () => {
  it('covers the whole calendar month', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
});

describe('computeSplit', () => {
  it('works the issue example: at 60/40, Pat paid $1,100 and Alex $1,900, so Pat pays Alex $700', () => {
    const m = month([row({ amount: 1100 }), row({ amount: 1900, owner: 'Alex' })]);
    expect(m.spouseOwesSelf).toBe(440);
    expect(m.selfOwesSpouse).toBe(1140);
    expect(m.monthNet).toBe(-700);
    expect(m.toSettle).toBe(-700);
    expect(m.jointTotal).toBe(3000);
    expect(m.status).toBe('open');
    expect(m.tagIds).toHaveLength(2);
  });

  it('nets a refund against the sum it falls in', () => {
    const m = month([row({ amount: 100 }), row({ amount: -50 })]);
    expect(m.selfPaid).toBe(50);
    expect(m.spouseOwesSelf).toBe(20);
  });

  it('uses the ratio in effect on each transaction date when the ratio changes mid-month', () => {
    const ratios = [{ startDate: '2026-01-01', selfPct: 60 }, { startDate: '2026-10-15', selfPct: 45 }];
    const m = month([row({ date: '2026-10-10', amount: 600 }), row({ date: '2026-10-20', amount: 500 })], '2026-10', ratios);
    expect(m.spouseOwesSelf).toBe(240 + 275);
    expect(m.slices).toEqual([
      { selfPct: 60, from: '2026-10-01', to: '2026-10-14', selfPaid: 600, spousePaid: 0, spouseOwesSelf: 240, selfOwesSpouse: 0 },
      { selfPct: 45, from: '2026-10-15', to: '2026-10-31', selfPaid: 500, spousePaid: 0, spouseOwesSelf: 275, selfOwesSpouse: 0 },
    ]);
  });

  it('settling part of a month and topping up later adds up to settling it all at once', () => {
    const a = row({ amount: 100 });
    const b = row({ amount: 50, owner: 'Alex' });
    const late = row({ amount: 31 });
    const allAtOnce = month([a, b, late]);
    const topUp = month([{ ...a, settled: true }, { ...b, settled: true }, late]);
    expect(topUp.status).toBe('top-up');
    expect(topUp.alreadySettled).toBe(10);       // 40% of 100 − 60% of 50
    expect(topUp.toSettle).toBe(12.4);           // 40% of the late $31
    expect(topUp.tagIds).toEqual([late.id]);
    expect(topUp.alreadySettled + topUp.toSettle).toBeCloseTo(allAtOnce.toSettle, 10);
    expect(topUp.monthNet).toBe(allAtOnce.monthNet);
  });

  it('is settled once every counted transaction carries the settled tag', () => {
    const m = month([row({ settled: true }), row({ owner: 'Alex', settled: true })]);
    expect(m.status).toBe('settled');
    expect(m.toSettle).toBe(0);
    expect(m.tagIds).toEqual([]);
  });

  it.each([
    ['lost its joint tag', { joint: false }],
    ['moved to a hidden category', { hidden: true }],
    ['was ignored', { ignored: true }],
  ])('reverses a settled transaction that %s', (_label, change) => {
    const t = row({ amount: 100, settled: true, ...change });
    const m = month([t]);
    expect(m.untagIds).toEqual([t.id]);
    expect(m.alreadySettled).toBe(40);
    expect(m.toSettle).toBe(-40);
    expect(m.monthNet).toBe(0);
    expect(m.status).toBe('top-up');
  });

  it('blocks a to-settle transaction on an account owned by neither self nor spouse', () => {
    const unowned = row({ owner: null, amount: 20 });
    const kid = row({ owner: 'Kid', amount: 30 });
    const m = month([row({ amount: 100 }), unowned, kid]);
    expect(m.blockedIds).toEqual([unowned.id, kid.id]);
    expect(m.jointTotal).toBe(150);              // still part of the joint total…
    expect(m.selfPaid + m.spousePaid).toBe(100); // …but in neither person's sum
    expect(m.spouseOwesSelf).toBe(40);
  });

  it('does not block an unowned transaction that was already settled', () => {
    expect(month([row({ owner: null, settled: true })]).blockedIds).toEqual([]);
  });

  it('counts pending joint transactions for the warning but leaves them out of the math', () => {
    const m = month([row({ amount: 100 }), row({ amount: 999, pending: true })]);
    expect(m.pendingCount).toBe(1);
    expect(m.jointTotal).toBe(100);
    expect(m.tagIds).toHaveLength(1);
  });

  it('leaves joint transactions in a hidden category out, and counts them', () => {
    const m = month([row({ amount: 100 }), row({ amount: 500, hidden: true })]);
    expect(m.hiddenCount).toBe(1);
    expect(m.jointTotal).toBe(100);
    expect(m.tagIds).toHaveLength(1);
  });

  it('ignores transactions that carry neither the joint nor the settled tag', () => {
    expect(month([row({ joint: false })]).status).toBe('empty');
  });

  it('keeps each share unrounded and rounds only the total', () => {
    // 40% of $10.01 is $4.004; rounding each would give $12.00, not $12.01.
    const m = month([row({ amount: 10.01 }), row({ amount: 10.01 }), row({ amount: 10.01 })]);
    expect(m.spouseOwesSelf).toBe(12.01);
  });

  it('rounds half a cent away from zero in both directions', () => {
    const even = [{ startDate: '2026-01-01', selfPct: 50 }];
    expect(month([row({ amount: 0.01 })], '2026-10', even).toSettle).toBe(0.01);
    expect(month([row({ amount: 0.01, owner: 'Alex' })], '2026-10', even).toSettle).toBe(-0.01);
  });

  it('never reports negative zero', () => {
    expect(Object.is(month([row({ settled: true })]).toSettle, 0)).toBe(true);
  });

  it('lists every month from the first ratio through today, newest first, ignoring earlier transactions', () => {
    const ratios = [{ startDate: '2026-08-20', selfPct: 60 }];
    const months = computeSplit([row({ date: '2026-08-10' }), row({ date: '2026-08-25' })], ratios, NAMES, '2026-10-02');
    expect(months.map((m) => m.month)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(months[1].status).toBe('empty');
    expect(months[2].jointTotal).toBe(100);      // only the Aug 25 transaction
    expect(months[2].slices[0].from).toBe('2026-08-20');
  });

  it('flags the current month as in progress', () => {
    const months = computeSplit([], RATIOS, NAMES, '2026-10-02');
    expect(months.find((m) => m.month === '2026-10')?.inProgress).toBe(true);
    expect(months.find((m) => m.month === '2026-09')?.inProgress).toBe(false);
  });

  it('is empty with no ratios', () => {
    expect(computeSplit([row()], [], NAMES, TODAY)).toEqual([]);
  });
});
