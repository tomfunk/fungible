import { describe, it, expect } from 'vitest';
import { getBalanceAge } from '../core/queries.js';

const now = new Date(2026, 9, 2); // 2026-10-02 local

function daysAgo(n: number): string {
  const d = new Date(2026, 9, 2 - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const csv = (type: string) => ({ id: 'chase', type, item_id: null });
const manual = (type: string) => ({ id: 'manual-house', type, item_id: null });

describe('getBalanceAge', () => {
  it('returns null for Plaid-linked accounts', () => {
    expect(getBalanceAge({ id: 'a', type: 'depository', item_id: 'item1' }, daysAgo(500), now)).toBeNull();
  });

  it('returns null when there is no balance row', () => {
    expect(getBalanceAge(csv('depository'), null, now)).toBeNull();
  });

  it('counts calendar days', () => {
    expect(getBalanceAge(csv('depository'), daysAgo(0), now)).toEqual({ days: 0, isStale: false });
    expect(getBalanceAge(csv('depository'), daysAgo(10), now)?.days).toBe(10);
  });

  it('uses 45 days for csv/manual depository and credit accounts', () => {
    expect(getBalanceAge(csv('depository'), daysAgo(45), now)?.isStale).toBe(false);
    expect(getBalanceAge(csv('depository'), daysAgo(46), now)?.isStale).toBe(true);
    expect(getBalanceAge(csv('credit'), daysAgo(46), now)?.isStale).toBe(true);
    expect(getBalanceAge(manual('depository'), daysAgo(46), now)?.isStale).toBe(true);
  });

  it('uses 45 days for any CSV account, even investment', () => {
    expect(getBalanceAge(csv('investment'), daysAgo(46), now)?.isStale).toBe(true);
  });

  it('uses 120 days for manual investment and other assets', () => {
    for (const t of ['investment', 'other']) {
      expect(getBalanceAge(manual(t), daysAgo(120), now)?.isStale).toBe(false);
      expect(getBalanceAge(manual(t), daysAgo(121), now)?.isStale).toBe(true);
    }
  });

  it('returns null for an unparseable date', () => {
    expect(getBalanceAge(csv('depository'), 'garbage', now)).toBeNull();
  });
});
