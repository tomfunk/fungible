import { describe, it, expect } from 'vitest';
import {
  bucketDrift, isSignificantDelta, ratioLabel, SIGNIFICANCE_FLOOR,
  isHighSeverityDrift, driftSeverity, HIGH_DRIFT_RATIO,
} from '../core/scorecard.js';
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

describe('isHighSeverityDrift', () => {
  it('is true when current/median12m clears the ratio', () => {
    expect(isHighSeverityDrift(150, 100)).toBe(true);  // 1.5x
    expect(isHighSeverityDrift(HIGH_DRIFT_RATIO * 100, 100)).toBe(true); // exactly 1.3x
  });

  it('is false when below the ratio', () => {
    expect(isHighSeverityDrift(120, 100)).toBe(false); // 1.2x
  });

  it('is true (bug fix) when median12m is 0, regardless of current', () => {
    // Old gui/tui inline check computed current/0 -> NaN >= 1.3 -> false,
    // silently downgrading a brand-new no-history category to "moderate".
    expect(isHighSeverityDrift(500, 0)).toBe(true);
    expect(isHighSeverityDrift(0, 0)).toBe(true);
  });
});

describe('driftSeverity', () => {
  it('is neutral when current and median12m are both 0', () => {
    expect(driftSeverity(0, 0)).toBe('neutral');
  });

  it('is neutral within the noise band (not a significant delta)', () => {
    // $100 over a $4,000 baseline is noise (needs $600, see isSignificantDelta)
    expect(driftSeverity(4100, 4000)).toBe('neutral');
  });

  it('is good when significantly under the baseline', () => {
    expect(driftSeverity(291, 762)).toBe('good'); // -471, well past the floor
  });

  it('is bad when significantly over and past the high-severity ratio', () => {
    expect(driftSeverity(626, 149)).toBe('bad'); // 4.2x
  });

  it('is caution when significantly over but under the high-severity ratio', () => {
    // +$300 over a $2,000 baseline (significant: > max(50, 300)) but only 1.15x
    expect(driftSeverity(2300, 2000)).toBe('caution');
  });

  it('is bad (bug fix) for new spending with no baseline history', () => {
    expect(driftSeverity(500, 0)).toBe('bad');
  });
});
