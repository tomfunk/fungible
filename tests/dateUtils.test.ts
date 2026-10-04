import { describe, it, expect } from 'vitest';
import {
  getPeriodStart,
  getPeriodDates,
  navigatePeriod,
  formatPeriodLabel,
  generatePeriods,
  MAX_PERIODS,
} from '../core/dateUtils.js';

// Helper: create a date at noon local time to avoid DST edge cases
const d = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12, 0, 0);

describe('getPeriodStart', () => {
  describe('week', () => {
    it('returns Monday when given a Monday', () => {
      const monday = d(2025, 1, 6); // Jan 6 2025 is a Monday
      const start = getPeriodStart('week', monday);
      expect(start.getFullYear()).toBe(2025);
      expect(start.getMonth()).toBe(0); // January
      expect(start.getDate()).toBe(6);
    });

    it('returns previous Monday when given a Wednesday', () => {
      const wednesday = d(2025, 1, 8); // Jan 8 is Wednesday
      const start = getPeriodStart('week', wednesday);
      expect(start.getDate()).toBe(6); // Monday Jan 6
    });

    it('returns previous Monday when given a Sunday', () => {
      const sunday = d(2025, 1, 12); // Jan 12 is Sunday
      const start = getPeriodStart('week', sunday);
      expect(start.getDate()).toBe(6); // Monday Jan 6
    });

    it('handles week spanning month boundary', () => {
      const wednesday = d(2025, 2, 5); // Feb 5 is Wednesday
      const start = getPeriodStart('week', wednesday);
      expect(start.getMonth()).toBe(1); // February (month index 1)
      expect(start.getDate()).toBe(3);  // Monday Feb 3
    });
  });

  describe('month', () => {
    it('returns first day of the month', () => {
      const mid = d(2025, 3, 15);
      const start = getPeriodStart('month', mid);
      expect(start.getMonth()).toBe(2); // March
      expect(start.getDate()).toBe(1);
    });

    it('returns first day of month when given the last day', () => {
      const end = d(2025, 1, 31);
      const start = getPeriodStart('month', end);
      expect(start.getDate()).toBe(1);
      expect(start.getMonth()).toBe(0);
    });
  });

  describe('quarter', () => {
    it('Q1: returns Jan 1', () => {
      const start = getPeriodStart('quarter', d(2025, 2, 15));
      expect(start.getMonth()).toBe(0);
      expect(start.getDate()).toBe(1);
    });

    it('Q2: returns Apr 1', () => {
      const start = getPeriodStart('quarter', d(2025, 5, 15));
      expect(start.getMonth()).toBe(3);
      expect(start.getDate()).toBe(1);
    });

    it('Q3: returns Jul 1', () => {
      const start = getPeriodStart('quarter', d(2025, 8, 1));
      expect(start.getMonth()).toBe(6);
      expect(start.getDate()).toBe(1);
    });

    it('Q4: returns Oct 1', () => {
      const start = getPeriodStart('quarter', d(2025, 11, 30));
      expect(start.getMonth()).toBe(9);
      expect(start.getDate()).toBe(1);
    });
  });

  describe('year', () => {
    it('returns January 1st of the year', () => {
      const start = getPeriodStart('year', d(2025, 7, 4));
      expect(start.getFullYear()).toBe(2025);
      expect(start.getMonth()).toBe(0);
      expect(start.getDate()).toBe(1);
    });
  });

  describe('last30', () => {
    it('returns 29 days before the given date (trailing window start)', () => {
      const start = getPeriodStart('last30', d(2026, 7, 3));
      expect(start.getFullYear()).toBe(2026);
      expect(start.getMonth()).toBe(5); // June
      expect(start.getDate()).toBe(4);
    });

    it('crosses year boundaries', () => {
      const start = getPeriodStart('last30', d(2026, 1, 10));
      expect(start.getFullYear()).toBe(2025);
      expect(start.getMonth()).toBe(11); // December
      expect(start.getDate()).toBe(12);
    });
  });

  describe('alltime', () => {
    it('returns year 2000', () => {
      const start = getPeriodStart('alltime', d(2025, 1, 1));
      expect(start.getFullYear()).toBe(2000);
    });
  });
});

describe('getPeriodDates', () => {
  it('alltime returns fixed range', () => {
    const dates = getPeriodDates('alltime', d(2025, 6, 15));
    expect(dates.from).toBe('2000-01-01');
    expect(dates.to).toBe('2099-12-31');
  });

  describe('week', () => {
    it('returns 7-day range starting from anchor', () => {
      const anchor = d(2025, 1, 6); // Monday Jan 6
      const dates = getPeriodDates('week', anchor);
      expect(dates.from).toBe('2025-01-06');
      expect(dates.to).toBe('2025-01-12'); // Sunday Jan 12
    });
  });

  describe('month', () => {
    it('returns full month range', () => {
      const anchor = d(2025, 1, 1); // Jan 1
      const dates = getPeriodDates('month', anchor);
      expect(dates.from).toBe('2025-01-01');
      expect(dates.to).toBe('2025-01-31');
    });

    it('handles February correctly', () => {
      const anchor = d(2025, 2, 1); // Feb 1, non-leap year
      const dates = getPeriodDates('month', anchor);
      expect(dates.from).toBe('2025-02-01');
      expect(dates.to).toBe('2025-02-28');
    });

    it('handles February in leap year', () => {
      const anchor = d(2024, 2, 1); // Feb 1, 2024 (leap year)
      const dates = getPeriodDates('month', anchor);
      expect(dates.from).toBe('2024-02-01');
      expect(dates.to).toBe('2024-02-29');
    });
  });

  describe('quarter', () => {
    it('Q1 ends on Mar 31', () => {
      const anchor = d(2025, 1, 1);
      const dates = getPeriodDates('quarter', anchor);
      expect(dates.from).toBe('2025-01-01');
      expect(dates.to).toBe('2025-03-31');
    });

    it('Q2 ends on Jun 30', () => {
      const anchor = d(2025, 4, 1);
      const dates = getPeriodDates('quarter', anchor);
      expect(dates.from).toBe('2025-04-01');
      expect(dates.to).toBe('2025-06-30');
    });

    it('Q4 ends on Dec 31', () => {
      const anchor = d(2025, 10, 1);
      const dates = getPeriodDates('quarter', anchor);
      expect(dates.from).toBe('2025-10-01');
      expect(dates.to).toBe('2025-12-31');
    });
  });

  describe('year', () => {
    it('returns full year range', () => {
      const anchor = d(2025, 1, 1);
      const dates = getPeriodDates('year', anchor);
      expect(dates.from).toBe('2025-01-01');
      expect(dates.to).toBe('2025-12-31');
    });
  });

  describe('last30', () => {
    it('returns a 30-day range starting at the anchor', () => {
      const dates = getPeriodDates('last30', d(2026, 6, 4));
      expect(dates.from).toBe('2026-06-04');
      expect(dates.to).toBe('2026-07-03');
    });

    it('spans month and year boundaries', () => {
      const dates = getPeriodDates('last30', d(2025, 12, 15));
      expect(dates.from).toBe('2025-12-15');
      expect(dates.to).toBe('2026-01-13');
    });
  });
});

describe('navigatePeriod', () => {
  describe('week navigation', () => {
    it('moves forward 7 days', () => {
      const anchor = d(2025, 1, 6);
      const next = navigatePeriod('week', anchor, 1);
      expect(next.getDate()).toBe(13);
    });

    it('moves backward 7 days', () => {
      const anchor = d(2025, 1, 13);
      const prev = navigatePeriod('week', anchor, -1);
      expect(prev.getDate()).toBe(6);
    });
  });

  describe('month navigation', () => {
    it('moves forward one month', () => {
      const anchor = d(2025, 1, 1);
      const next = navigatePeriod('month', anchor, 1);
      expect(next.getMonth()).toBe(1); // February
      expect(next.getFullYear()).toBe(2025);
    });

    it('moves backward one month', () => {
      const anchor = d(2025, 3, 1);
      const prev = navigatePeriod('month', anchor, -1);
      expect(prev.getMonth()).toBe(1); // February
    });

    it('wraps year boundary going forward', () => {
      const anchor = d(2025, 12, 1);
      const next = navigatePeriod('month', anchor, 1);
      expect(next.getMonth()).toBe(0); // January
      expect(next.getFullYear()).toBe(2026);
    });

    it('wraps year boundary going backward', () => {
      const anchor = d(2025, 1, 1);
      const prev = navigatePeriod('month', anchor, -1);
      expect(prev.getMonth()).toBe(11); // December
      expect(prev.getFullYear()).toBe(2024);
    });
  });

  describe('quarter navigation', () => {
    it('moves forward 3 months', () => {
      const anchor = d(2025, 1, 1);
      const next = navigatePeriod('quarter', anchor, 1);
      expect(next.getMonth()).toBe(3); // April
    });

    it('moves backward 3 months', () => {
      const anchor = d(2025, 4, 1);
      const prev = navigatePeriod('quarter', anchor, -1);
      expect(prev.getMonth()).toBe(0); // January
    });
  });

  describe('year navigation', () => {
    it('moves forward one year', () => {
      const anchor = d(2025, 1, 1);
      const next = navigatePeriod('year', anchor, 1);
      expect(next.getFullYear()).toBe(2026);
    });

    it('moves backward one year', () => {
      const anchor = d(2025, 1, 1);
      const prev = navigatePeriod('year', anchor, -1);
      expect(prev.getFullYear()).toBe(2024);
    });
  });

  describe('last30 navigation', () => {
    it('moves backward 30 days', () => {
      const prev = navigatePeriod('last30', d(2026, 6, 4), -1);
      expect(prev.getMonth()).toBe(4); // May
      expect(prev.getDate()).toBe(5);
    });

    it('moves forward 30 days', () => {
      const next = navigatePeriod('last30', d(2026, 6, 4), 1);
      expect(next.getMonth()).toBe(6); // July
      expect(next.getDate()).toBe(4);
    });
  });

  describe('alltime navigation', () => {
    it('does not move (alltime is fixed)', () => {
      const anchor = d(2025, 6, 15);
      const result = navigatePeriod('alltime', anchor, 1);
      expect(result.getTime()).toBe(anchor.getTime());
    });
  });
});

describe('formatPeriodLabel', () => {
  it('formats week label same month', () => {
    const anchor = d(2025, 1, 6); // Mon Jan 6
    // Week ends Jan 12
    expect(formatPeriodLabel('week', anchor)).toBe('Jan 6–12, 2025');
  });

  it('formats week label spanning months', () => {
    const anchor = d(2025, 1, 27); // Mon Jan 27, ends Feb 2
    expect(formatPeriodLabel('week', anchor)).toBe('Jan 27 – Feb 2, 2025');
  });

  it('formats week spanning years', () => {
    const anchor = d(2024, 12, 30); // Mon Dec 30, ends Jan 5 2025
    expect(formatPeriodLabel('week', anchor)).toBe('Dec 30 – Jan 5, 2025');
  });

  it('formats month label', () => {
    expect(formatPeriodLabel('month', d(2025, 3, 15))).toBe('Mar 2025');
    expect(formatPeriodLabel('month', d(2025, 12, 1))).toBe('Dec 2025');
  });

  it('formats quarter label', () => {
    expect(formatPeriodLabel('quarter', d(2025, 1, 1))).toBe('Q1 2025');
    expect(formatPeriodLabel('quarter', d(2025, 4, 1))).toBe('Q2 2025');
    expect(formatPeriodLabel('quarter', d(2025, 7, 1))).toBe('Q3 2025');
    expect(formatPeriodLabel('quarter', d(2025, 10, 1))).toBe('Q4 2025');
  });

  it('formats year label', () => {
    expect(formatPeriodLabel('year', d(2025, 6, 15))).toBe('2025');
  });

  it('formats last30 label spanning months', () => {
    expect(formatPeriodLabel('last30', d(2026, 6, 4))).toBe('Jun 4 – Jul 3, 2026');
  });

  it('formats last30 label within one month', () => {
    expect(formatPeriodLabel('last30', d(2026, 1, 1))).toBe('Jan 1–30, 2026');
  });

  it('formats last30 label spanning years', () => {
    expect(formatPeriodLabel('last30', d(2025, 12, 15))).toBe('Dec 15 – Jan 13, 2026');
  });

  it('formats alltime label', () => {
    expect(formatPeriodLabel('alltime', d(2025, 1, 1))).toBe('All Time');
  });
});

describe('generatePeriods', () => {
  // The '-31' period ends (e.g. '2025-06-31') are intentional end-of-period sentinels
  // for plain string comparison against ISO dates, not real calendar dates.
  it.each([
    ['March', '2025-03-15', 'Q1 2025', '2025-01-01', '2025-03-31'],
    ['June', '2025-06-30', 'Q2 2025', '2025-04-01', '2025-06-31'],
    ['September', '2025-09-01', 'Q3 2025', '2025-07-01', '2025-09-31'],
    ['December', '2025-12-31', 'Q4 2025', '2025-10-01', '2025-12-31'],
  ])('a date in %s falls in exactly one quarter starting on the right month', (_m, date, label, from, to) => {
    expect(generatePeriods('quarter', date, date)).toEqual([{ label, from, to }]);
  });

  it('walks quarters across a year boundary', () => {
    expect(generatePeriods('quarter', '2024-11-05', '2025-04-02').map((p) => p.from))
      .toEqual(['2024-10-01', '2025-01-01', '2025-04-01']);
  });

  it('week periods include the final week when `to` is exactly a period start', () => {
    expect(generatePeriods('week', '2025-01-06', '2025-01-13').map((p) => p.from))
      .toEqual(['2025-01-06', '2025-01-13']);
  });

  it('a single-day range yields one week period spanning 7 days', () => {
    expect(generatePeriods('week', '2025-01-06', '2025-01-06')).toEqual([
      { label: 'Jan 6–12 2025', from: '2025-01-06', to: '2025-01-12' },
    ]);
  });

  it.each([
    ['week', '2025-01-06', '2025-01-20', ['2025-01-06', '2025-01-13', '2025-01-20']],
    ['month', '2024-11-15', '2025-01-02', ['2024-11-01', '2024-12-01', '2025-01-01']],
    ['year', '2023-06-01', '2025-02-01', ['2023-01-01', '2024-01-01', '2025-01-01']],
  ] as const)('%s ranges are unchanged by the cap', (range, from, to, froms) => {
    expect(generatePeriods(range, from, to).map((p) => p.from)).toEqual(froms);
  });

  it.each(['week', 'month', 'quarter', 'year'] as const)('%s with from after to yields no periods', (range) => {
    expect(generatePeriods(range, '2025-06-01', '2024-01-01')).toEqual([]);
  });

  it('a range of exactly MAX_PERIODS periods completes', () => {
    expect(generatePeriods('quarter', '0001-01-01', '2500-12-31')).toHaveLength(MAX_PERIODS);
  });

  it.each([
    ['week', '1900-01-01', '2900-01-01'],
    ['month', '1000-01-01', '2000-01-01'],
    ['quarter', '0001-01-01', '2501-01-01'],
  ] as const)('%s range over the cap throws a clear error instead of spinning', (range, from, to) => {
    expect(() => generatePeriods(range, from, to)).toThrow(/exceeds the 10000-period limit/);
  });

  it('a month range to year 9999 (~120k periods) fails fast with the cap error', () => {
    expect(() => generatePeriods('month', '2025-01-01', '9999-12-31')).toThrow(/period limit/);
  });

  it('a non-numeric bound yields no periods for month/year (no loop entered)', () => {
    expect(generatePeriods('month', '2025-01-01', 'garbage')).toEqual([]);
    expect(generatePeriods('year', 'garbage', '2025-01-01')).toEqual([]);
  });
  // Boundary per branch: N periods completes, N+1 throws (pins >= vs >, and that
  // every branch routes through the cap).
  it.each([
    ['week', '2025-01-06', (n: number) => { const d = new Date('2025-01-06T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d.toISOString().slice(0, 10); }],
    ['month', '0001-01-01', (n: number) => `${String(1 + Math.floor((n - 1) / 12)).padStart(4, '0')}-${String(((n - 1) % 12) + 1).padStart(2, '0')}-01`],
  ] as const)('%s: exactly MAX_PERIODS completes, one more throws', (range, from, toFor) => {
    expect(generatePeriods(range, from, toFor(MAX_PERIODS))).toHaveLength(MAX_PERIODS);
    expect(() => generatePeriods(range, from, toFor(MAX_PERIODS + 1))).toThrow(/period limit/);
  });

  it('week range with a non-date `to` throws the cap error instead of looping forever', () => {
    // Lexicographic compare made "2025-01-01" <= "garbage" always true.
    expect(() => generatePeriods('week', '2025-01-01', 'garbage')).toThrow(/period limit/);
  });
});
