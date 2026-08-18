import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fmt, fmtSigned, fmtPct, fmtMonths, fmtCompact, fmtTimeAgo, fmtSyncedAt } from '../core/fmt.js';
import { MONTHS } from '../core/dateUtils.js';
import { bar, truncate } from '../tui/charUtils.js';

describe('fmt', () => {
  it('formats positive numbers with dollar sign', () => {
    expect(fmt(1234.56)).toBe('$1,234.56');
  });

  it('formats negative numbers with a minus sign', () => {
    expect(fmt(-50)).toBe('-$50.00');
  });

  it('formats zero', () => {
    expect(fmt(0)).toBe('$0.00');
  });

  it('respects custom decimals', () => {
    expect(fmt(1000, 0)).toBe('$1,000');
    expect(fmt(1.5, 1)).toBe('$1.5');
  });
});

describe('fmtSigned', () => {
  it('prepends + for positive numbers', () => {
    expect(fmtSigned(100)).toBe('+$100.00');
  });

  it('prepends - for negative numbers', () => {
    expect(fmtSigned(-50)).toBe('-$50.00');
  });

  it('treats zero as positive', () => {
    expect(fmtSigned(0)).toBe('+$0.00');
  });
});

describe('fmtPct', () => {
  it('formats a percentage with one decimal by default', () => {
    expect(fmtPct(25)).toBe('25.0%');
  });

  it('respects custom decimals', () => {
    expect(fmtPct(33.333, 2)).toBe('33.33%');
  });

  it('handles zero', () => {
    expect(fmtPct(0)).toBe('0.0%');
  });
});

describe('fmtMonths', () => {
  it('formats finite months', () => {
    expect(fmtMonths(3.2)).toBe('3.2 mo');
  });

  it('returns ∞ for Infinity', () => {
    expect(fmtMonths(Infinity)).toBe('∞');
  });

  it('returns ∞ for values over 999', () => {
    expect(fmtMonths(1000)).toBe('∞');
  });

  it('returns ∞ for NaN', () => {
    expect(fmtMonths(NaN)).toBe('∞');
  });
});

describe('fmtCompact', () => {
  it('abbreviates millions', () => {
    expect(fmtCompact(1_838_641.96)).toBe('$1.84M');
    expect(fmtCompact(3_870_000)).toBe('$3.87M');
  });

  it('abbreviates ten-thousands and above as K', () => {
    expect(fmtCompact(68_619.40)).toBe('$68.6K');
    expect(fmtCompact(21_493.79)).toBe('$21.5K');
  });

  it('falls through to full fmt below 10K', () => {
    expect(fmtCompact(5_000)).toBe('$5,000.00');
    expect(fmtCompact(999)).toBe('$999.00');
  });

  it('preserves sign for negative values', () => {
    expect(fmtCompact(-2_000_000)).toBe('-$2.00M');
    expect(fmtCompact(-50_000)).toBe('-$50.0K');
    expect(fmtCompact(-5_000)).toBe('-$5,000.00');
  });
});

describe('bar', () => {
  it('returns all empty for zero amount', () => {
    expect(bar(0, 100, 10)).toBe('░'.repeat(10));
  });

  it('returns all filled when amount equals max', () => {
    expect(bar(100, 100, 10)).toBe('█'.repeat(10));
  });

  it('returns partial bar for middle value', () => {
    const result = bar(50, 100, 10);
    expect(result).toBe('█████░░░░░');
  });

  it('clamps at 100% when amount exceeds max', () => {
    expect(bar(200, 100, 10)).toBe('█'.repeat(10));
  });

  it('uses absolute value of amount', () => {
    expect(bar(-50, 100, 10)).toBe(bar(50, 100, 10));
  });

  it('returns all empty when max is 0', () => {
    expect(bar(50, 0, 10)).toBe('░'.repeat(10));
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns exact-length strings unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates strings over the limit with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
  });
});

describe('fmtTimeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('returns "never" for null', () => {
    expect(fmtTimeAgo(null)).toBe('never');
  });

  it('returns "just now" for under 2 minutes ago', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 90_000); // 90 seconds later
    expect(fmtTimeAgo(now)).toBe('just now');
  });

  it('returns minutes for 2–59 minutes ago', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 5 * 60_000);
    expect(fmtTimeAgo(now)).toBe('5 min ago');
  });

  it('returns hours for 1–23 hours ago', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 3 * 60 * 60_000);
    expect(fmtTimeAgo(now)).toBe('3 hr ago');
  });

  it('returns singular "day" for exactly 1 day ago', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 24 * 60 * 60_000);
    expect(fmtTimeAgo(now)).toBe('1 day ago');
  });

  it('returns plural "days" for multiple days ago', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 5 * 24 * 60 * 60_000);
    expect(fmtTimeAgo(now)).toBe('5 days ago');
  });
});

describe('fmtSyncedAt', () => {
  // A fixed clock keeps the day-boundary cases from drifting with the real date.
  const NOW = new Date('2026-07-29T12:00:00Z').getTime();
  const DAY = 24 * 60 * 60 * 1000;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it('returns "never" for null', () => {
    expect(fmtSyncedAt(null)).toBe('never');
  });

  it('delegates to fmtTimeAgo within the last 24 hours', () => {
    expect(fmtSyncedAt(NOW - 5 * 60_000)).toBe('5 min ago');
    expect(fmtSyncedAt(NOW - 20 * 60 * 60_000)).toBe('20 hr ago');
  });

  it('switches to a plain date once "N days ago" stops being scannable', () => {
    const dt = new Date(NOW - 3 * DAY);
    expect(fmtSyncedAt(NOW - 3 * DAY)).toBe(`${MONTHS[dt.getMonth()]} ${dt.getDate()}`);
    expect(fmtSyncedAt(NOW - 3 * DAY)).not.toContain('days ago');
  });

  it('picks the date arm exactly at the 24-hour boundary', () => {
    const dt = new Date(NOW - DAY);
    expect(fmtSyncedAt(NOW - DAY)).toBe(`${MONTHS[dt.getMonth()]} ${dt.getDate()}`);
    // One millisecond inside the window is still relative.
    expect(fmtSyncedAt(NOW - DAY + 1)).toBe('23 hr ago');
  });
});
