import { describe, it, expect } from 'vitest';
import { parseDate } from '../core/csv-date.js';
import { dedupKey, assignOrdinals } from '../core/csv.js';

describe('parseDate', () => {
  it('passes through YYYY-MM-DD format unchanged', () => {
    expect(parseDate('2024-03-15')).toBe('2024-03-15');
  });

  it('converts M/D/YY format with year < 50', () => {
    expect(parseDate('3/15/24')).toBe('2024-03-15');
  });

  it('converts M/D/YY format with year >= 50 to 1900s', () => {
    expect(parseDate('3/15/99')).toBe('1999-03-15');
  });

  it('converts M/D/YYYY format', () => {
    expect(parseDate('3/15/2024')).toBe('2024-03-15');
  });

  it('pads single-digit month and day', () => {
    expect(parseDate('1/5/2023')).toBe('2023-01-05');
  });

  it('returns raw string for unrecognized format', () => {
    expect(parseDate('15 March 2024')).toBeNull();
  });
});

describe('parseDate calendar validation', () => {
  it.each(['13/45/2024', '2024-02-30', '2/29/2023', '2/30/2024', '0/5/2024', '2024-13-01', '2024-00-10',
    'March 5', '1/1/202', '', 'abc', '5/2024', '3-15-2024', '2024/03/15', '15/3/2024'])('rejects %j', (raw) => {
    expect(parseDate(raw)).toBeNull();
  });

  it.each([
    ['2/29/2024', '2024-02-29'], ['2024-02-29', '2024-02-29'], ['12/31/99', '1999-12-31'],
    ['1/1/49', '2049-01-01'], ['1/1/50', '1950-01-01'], [' 3/5/2024 ', '2024-03-05'],
  ])('accepts %j as %s', (raw, iso) => {
    expect(parseDate(raw)).toBe(iso);
  });
});

describe('dedupKey', () => {
  it('is deterministic — same inputs produce the same key', () => {
    expect(dedupKey('2024-01-15', 'AMAZON', 99.99, 0)).toBe(dedupKey('2024-01-15', 'AMAZON', 99.99, 0));
  });

  it('is case-insensitive and trims the name', () => {
    expect(dedupKey('2024-01-15', '  amazon  ', 99.99, 0)).toBe(dedupKey('2024-01-15', 'AMAZON', 99.99, 0));
  });

  it('separates different amounts', () => {
    expect(dedupKey('2024-01-15', 'AMAZON', 99.99, 0)).not.toBe(dedupKey('2024-01-15', 'AMAZON', 50, 0));
  });

  it('separates repeat occurrences by ordinal', () => {
    expect(dedupKey('2024-01-15', 'AMAZON', 99.99, 0)).not.toBe(dedupKey('2024-01-15', 'AMAZON', 99.99, 1));
  });

  // Interpolating the float directly would make the key depend on how a
  // language renders 5 versus 5.0, which the SQL and JS sides disagree about.
  it('normalizes amounts to integer cents', () => {
    expect(dedupKey('2024-01-15', 'AMAZON', 5, 0)).toBe(dedupKey('2024-01-15', 'AMAZON', 5.0, 0));
    expect(dedupKey('2024-01-15', 'AMAZON', 5, 0)).toContain('|500|');
  });

  it.each([[19.99, '1999'], [0.1 + 0.2, '30'], [-4.5, '-450'], [-0, '0'], [1.005, '100'], [4.5, '450']])(
    'reduces %d to integer cents %s', (amount, cents) => {
      expect(dedupKey('2024-01-15', 'X', amount, 0)).toBe(`2024-01-15|x|${cents}|0`);
  });
});

describe('assignOrdinals', () => {
  it('numbers identical rows in file order', () => {
    const rows = [
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
    ];
    expect(assignOrdinals(rows).map((r) => r.ord)).toEqual([0, 1, 2]);
  });

  it('counts each distinct row separately', () => {
    const rows = [
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
      { date: '2024-01-15', name: 'BAGEL',  amount: 4.5 },
      { date: '2024-01-16', name: 'COFFEE', amount: 4.5 },
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
    ];
    expect(assignOrdinals(rows).map((r) => r.ord)).toEqual([0, 0, 0, 1]);
  });

  it('is stable — the same file always produces the same ordinals', () => {
    const rows = [
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
      { date: '2024-01-15', name: 'COFFEE', amount: 4.5 },
    ];
    expect(assignOrdinals(rows)).toEqual(assignOrdinals(rows));
  });

  it('preserves the other fields on each row', () => {
    const rows = [{ date: '2024-01-15', name: 'COFFEE', amount: 4.5, rowIndex: 7 }];
    expect(assignOrdinals(rows)[0].rowIndex).toBe(7);
  });
});
