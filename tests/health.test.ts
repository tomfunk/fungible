import { describe, it, expect } from 'vitest';
import { yearsToFire, coastYears } from '../core/health.js';

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

