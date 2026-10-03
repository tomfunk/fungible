import { describe, it, expect } from 'vitest';
import { getBalanceAge, isManualAccountId } from '../core/queries.js';

const now = new Date('2026-10-02T12:00:00Z');

const csv = (type: string) => ({ id: 'chase', type, item_id: null });
const manual = (type: string) => ({ id: 'manual-house', type, item_id: null });

// Literal dates: 2026-10-02 minus N days.
const D = {
  0: '2026-10-02',
  10: '2026-09-22',
  44: '2026-08-19',
  45: '2026-08-18',
  46: '2026-08-17',
  119: '2026-06-05',
  120: '2026-06-04',
  121: '2026-06-03',
};

describe('getBalanceAge thresholds', () => {
  it.each([
    ['csv depository', csv('depository'), 44, false],
    ['csv depository', csv('depository'), 45, false],
    ['csv depository', csv('depository'), 46, true],
    ['csv credit', csv('credit'), 45, false],
    ['csv credit', csv('credit'), 46, true],
    ['csv investment', csv('investment'), 46, true],
    ['csv other', csv('other'), 46, true],
    ['manual depository', manual('depository'), 45, false],
    ['manual depository', manual('depository'), 46, true],
    ['manual credit', manual('credit'), 45, false],
    ['manual credit', manual('credit'), 46, true],
    ['manual investment', manual('investment'), 46, false],
    ['manual investment', manual('investment'), 119, false],
    ['manual investment', manual('investment'), 120, false],
    ['manual investment', manual('investment'), 121, true],
    ['manual other', manual('other'), 46, false],
    ['manual other', manual('other'), 119, false],
    ['manual other', manual('other'), 120, false],
    ['manual other', manual('other'), 121, true],
  ] as const)('%s at %i days -> stale=%s', (_label, account, days, stale) => {
    expect(getBalanceAge(account, D[days], now)).toEqual({ days, isStale: stale });
  });

  it.each([
    ['my-manual-house'],
    ['Manual-House'],
    ['house-manual-'],
  ])('id %s is treated as csv (45-day tier)', (id) => {
    expect(getBalanceAge({ id, type: 'other', item_id: null }, D[46], now)?.isStale).toBe(true);
  });
});

describe('getBalanceAge inputs', () => {
  it.each([
    ['empty string', ''],
    ['null', null],
    ['garbage', 'garbage'],
    ['impossible date', '2026-13-45'],
  ])('%s -> null', (_l, date) => {
    expect(getBalanceAge(csv('depository'), date, now)).toBeNull();
  });

  it('plaid account with an old date -> null', () => {
    expect(getBalanceAge({ id: 'a', type: 'depository', item_id: 'item1' }, '2020-01-01', now)).toBeNull();
  });

  it('future-dated balance clamps to 0 days, not stale', () => {
    expect(getBalanceAge(csv('depository'), '2026-12-25', now)).toEqual({ days: 0, isStale: false });
  });

  it('parses a full ISO timestamp as its date', () => {
    expect(getBalanceAge(csv('depository'), '2026-09-01T23:30:00Z', now)).toEqual({ days: 31, isStale: false });
  });

  it('counts plain days', () => {
    expect(getBalanceAge(csv('depository'), D[0], now)).toEqual({ days: 0, isStale: false });
    expect(getBalanceAge(csv('depository'), D[10], now)?.days).toBe(10);
  });
});

describe('getBalanceAge UTC day boundary', () => {
  it.each([
    ['2026-10-02T23:59:59.999Z', '2026-10-02', 0],
    ['2026-10-02T23:59:59.999Z', '2026-10-01', 1],
    ['2026-10-03T00:00:00.001Z', '2026-10-02', 1],
    ['2026-10-03T00:00:00.001Z', '2026-10-03', 0],
  ])('now=%s balance=%s -> %i days', (iso, date, days) => {
    expect(getBalanceAge(csv('depository'), date, new Date(iso))?.days).toBe(days);
  });
});

describe('isManualAccountId', () => {
  it.each([
    ['manual-123', true],
    ['manual-', true],
    ['my-manual-house', false],
    ['Manual-House', false],
    ['chase', false],
    ['', false],
  ])('%s -> %s', (id, expected) => {
    expect(isManualAccountId(id)).toBe(expected);
  });
});
