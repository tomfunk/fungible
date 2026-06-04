import { describe, it, expect } from 'vitest';
import { fmt, fmtSigned, fmtPct, fmtMonths, fmtCompact } from '../core/fmt.js';
import { bar, truncate } from '../tui/charUtils.js';

describe('fmt', () => {
  it('formats positive numbers with dollar sign', () => {
    expect(fmt(1234.56)).toBe('$1,234.56');
  });

  it('formats negative numbers using absolute value', () => {
    expect(fmt(-50)).toBe('$50.00');
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
