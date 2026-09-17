import { describe, it, expect } from 'vitest';
import { bucketDrift, isSignificantDelta, ratioLabel, SIGNIFICANCE_FLOOR } from '../core/scorecard.js';
import type { CategoryDrift } from '../core/queries.js';

// Minimal CategoryDrift with only the fields the scorecard cares about filled
// meaningfully; the vs-prev/vs-year deltas are irrelevant to bucketing.
const row = (category: string, current: number, median12m: number): CategoryDrift => ({
  category, current,
  lastPeriodDelta: 0, lastYearDelta: 0,
  avg12m: median12m, avg12mDelta: current - median12m,
  median12m, medianDelta: current - median12m,
  basis: 'calendar-12mo', basisLabel: '12 complete periods',
});

describe('isSignificantDelta', () => {
  it('requires the absolute floor on small baselines', () => {
    expect(isSignificantDelta(49, 0)).toBe(false);
    expect(isSignificantDelta(SIGNIFICANCE_FLOOR, 0)).toBe(true);
    expect(isSignificantDelta(-49, 100)).toBe(false);
    expect(isSignificantDelta(-60, 100)).toBe(true);
  });

  it('requires a share of the baseline on large baselines', () => {
    // $100 over a $4,000 baseline is noise (needs $600)
    expect(isSignificantDelta(100, 4000)).toBe(false);
    expect(isSignificantDelta(700, 4000)).toBe(true);
  });
});

describe('ratioLabel', () => {
  it('formats a multiplier vs baseline', () => {
    expect(ratioLabel(626, 149)).toBe('4.2x');
    expect(ratioLabel(291, 762)).toBe('0.4x');
  });

  it('labels spending with no baseline as n/a', () => {
    expect(ratioLabel(100, 0)).toBe('n/a');
    expect(ratioLabel(0, 0)).toBe('');
  });
});

describe('bucketDrift', () => {
  it('splits rows into over / typical / under', () => {
    const { over, typical, under } = bucketDrift([
      row('Transportation', 626, 149),   // +477, way over
      row('Bills', 4112, 4132),          // -20, noise on a big baseline
      row('Grocery', 291, 762),          // -471, well under
    ]);
    expect(over.map((r) => r.category)).toEqual(['Transportation']);
    expect(typical.map((r) => r.category)).toEqual(['Bills']);
    expect(under.map((r) => r.category)).toEqual(['Grocery']);
  });

  it('buckets zero-baseline new spending as over once past the floor', () => {
    const { over, typical } = bucketDrift([
      row('NewSub', 80, 0),
      row('TinyNew', 20, 0),
    ]);
    expect(over.map((r) => r.category)).toEqual(['NewSub']);
    expect(typical.map((r) => r.category)).toEqual(['TinyNew']);
  });

  it('sorts over worst-first and under biggest-saving-last', () => {
    const { over, under } = bucketDrift([
      row('Shopping', 1277, 1081),  // +196
      row('Travel', 1471, 1011),    // +460
      row('Grocery', 291, 762),     // -471
      row('Dining', 633, 784),      // -151
    ]);
    expect(over.map((r) => r.category)).toEqual(['Travel', 'Shopping']);
    expect(under.map((r) => r.category)).toEqual(['Dining', 'Grocery']);
  });

  it('nets deltas across all rows including typical ones', () => {
    const { net } = bucketDrift([
      row('Travel', 1471, 1011),  // +460
      row('Grocery', 291, 762),   // -471
      row('Bills', 4112, 4132),   // -20 (typical, still counted)
    ]);
    expect(net).toBeCloseTo(460 - 471 - 20);
  });

  it('preserves input order within typical', () => {
    const { typical } = bucketDrift([
      row('Bills', 4112, 4132),
      row('Insurance', 162, 160),
      row('Home', 271, 302),
    ]);
    expect(typical.map((r) => r.category)).toEqual(['Bills', 'Insurance', 'Home']);
  });
});
