import { describe, it, expect } from 'vitest';
import { parseCsvAmount, resolveCsvAmount } from '../core/csv-amount.js';
import { makeCsvRow, makeSplitCsvRow } from './helpers/makeCsvRow.js';

describe('parseCsvAmount', () => {
  it.each([
    ['100.00', 100], ['4.50', 4.5], ['-4.50', -4.5], ['$4.50', 4.5], ['$50.25', 50.25],
    ['-$5', -5], ['$-5', -5], ['-75.00', -75], ['1,234.56', 1234.56], ['$1,234.56', 1234.56],
    ['(20.00)', -20], ['(100.00)', -100], ['($1,234.56)', -1234.56], ['($200.00)', -200],
    ['+5', 5], ['  4.50  ', 4.5], ['.50', 0.5], ['5.', 5], ['5', 5], ['0', 0], ['0.00', 0],
  ])('parses %j as %d', (raw, expected) => {
    expect(parseCsvAmount(raw)).toBeCloseTo(expected);
  });

  it('normalises -0 to 0', () => {
    expect(Object.is(parseCsvAmount('-0'), 0)).toBe(true);
    expect(Object.is(parseCsvAmount('(0.00)'), 0)).toBe(true);
  });

  it.each([
    'abc', '4.50abc', '1.234,56', '1234,56', '1,23', '--5', '$', '()', '5-', 'NaN', 'Infinity',
    '1e3', '€5', '£5', '5 USD', '', '   ', '(-5)', '1,2345',
  ])('rejects %j', (raw) => {
    expect(parseCsvAmount(raw)).toBeNull();
  });
});

describe('resolveCsvAmount', () => {
  const amount = (n: number) => ({ ok: true, amount: n });
  const fail = (reason: string) => ({ ok: false, reason });

  describe('split mode (separate debit/credit columns)', () => {
    const cfg = makeSplitCsvRow();
    const r = (debit?: string, credit?: string) => {
      const row = ['1/1/24', 'x'];
      if (debit !== undefined) row.push(debit);
      if (credit !== undefined) row.push(credit);
      return resolveCsvAmount(row, cfg);
    };

    it('uses the debit column as a positive (outflow) amount', () => {
      expect(r('4.50', '')).toEqual(amount(4.5));
      expect(r('$4.50', '')).toEqual(amount(4.5));
    });

    it('negates the credit column (inflow) when debit is blank or zero', () => {
      expect(r('0', '20.00')).toEqual(amount(-20));
      expect(r('', '20.00')).toEqual(amount(-20));
      expect(r('', '$1,234.56')).toEqual(amount(-1234.56));
    });

    it('both blank is empty_amount, not 0', () => {
      expect(r('', '')).toEqual(fail('empty_amount'));
      expect(r(' ', ' ')).toEqual(fail('empty_amount'));
    });

    it('an undefined / out-of-range cell is empty_amount without throwing', () => {
      expect(r()).toEqual(fail('empty_amount'));
      expect(r('')).toEqual(fail('empty_amount'));
    });

    it('invalid debit is bad_amount even when credit is valid (no fallback)', () => {
      expect(r('abc', '20.00')).toEqual(fail('bad_amount'));
    });

    it('invalid credit with blank debit is bad_amount', () => {
      expect(r('', 'abc')).toEqual(fail('bad_amount'));
    });

    it('when both are filled the debit wins', () => {
      expect(r('4.50', '20.00')).toEqual(amount(4.5));
    });

    it('debit 0 and credit 0 resolve to a true 0, not -0', () => {
      const v = r('0', '0');
      expect(v.ok && Object.is(v.amount, 0)).toBe(true);
    });

    it('a lone zero debit is a valid 0', () => {
      expect(r('0.00', '')).toEqual(amount(0));
    });
  });

  describe('single mode (one amount column)', () => {
    it('passes the amount through when positiveIsInflow is false', () => {
      const cfg = makeCsvRow({ positiveIsInflow: false });
      expect(resolveCsvAmount(['1/1/24', 'Coffee', '4.50'], cfg)).toEqual(amount(4.5));
      expect(resolveCsvAmount(['1/1/24', 'Refund', '-20.00'], cfg)).toEqual(amount(-20));
      expect(resolveCsvAmount(['1/1/24', 'Refund', '(20.00)'], cfg)).toEqual(amount(-20));
    });

    it('flips the sign when positiveIsInflow is true', () => {
      const cfg = makeCsvRow({ positiveIsInflow: true });
      expect(resolveCsvAmount(['1/1/24', 'Deposit', '20.00'], cfg)).toEqual(amount(-20));
      expect(resolveCsvAmount(['1/1/24', 'Purchase', '-4.50'], cfg)).toEqual(amount(4.5));
      const zero = resolveCsvAmount(['1/1/24', 'x', '0'], cfg);
      expect(zero.ok && Object.is(zero.amount, 0)).toBe(true);
    });

    it("'$4.50' is not resolved as 0", () => {
      expect(resolveCsvAmount(['1/1/24', 'x', '$4.50'], makeCsvRow())).toEqual(amount(4.5));
    });

    it("'1,234.56' is not resolved as 1", () => {
      expect(resolveCsvAmount(['1/1/24', 'x', '1,234.56'], makeCsvRow())).toEqual(amount(1234.56));
    });

    it.each(['abc', '1.234,56', '1234,56', '5-'])('%j is bad_amount, not 0', (raw) => {
      expect(resolveCsvAmount(['1/1/24', 'x', raw], makeCsvRow())).toEqual(fail('bad_amount'));
    });

    it('blank or missing cell is empty_amount, not 0', () => {
      expect(resolveCsvAmount(['1/1/24', 'x', ''], makeCsvRow())).toEqual(fail('empty_amount'));
      expect(resolveCsvAmount(['1/1/24', 'x'], makeCsvRow())).toEqual(fail('empty_amount'));
    });
  });
});
