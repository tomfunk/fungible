import { describe, it, expect } from 'vitest';
import { parseDate } from '../core/csv-date.js';
import { dedupKey, assignOrdinals, parseCSV, parseCsvText } from '../core/csv.js';
import { createHash } from 'node:crypto';
import { useTempCsv } from './helpers/tempCsv.js';

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

describe('parseCsvText', () => {
  const H = 'D,N,A';
  it.each<[string, string, string[][], number[]]>([
    ['BOM', `\uFEFF${H}\n1,a,2`, [['1', 'a', '2']], [2]],
    ['CRLF', `${H}\r\n1,a,2\r\n3,b,4\r\n`, [['1', 'a', '2'], ['3', 'b', '4']], [2, 3]],
    ['lone CR', `${H}\r1,a,2\r3,b,4`, [['1', 'a', '2'], ['3', 'b', '4']], [2, 3]],
    ['doubled quotes', `${H}\n1,"a ""b"" c",2`, [['1', 'a "b" c', '2']], [2]],
    ['quoted comma', `${H}\n1,"Smith, J",2`, [['1', 'Smith, J', '2']], [2]],
    ['embedded newline keeps one row, next line correct', `${H}\n1,"two\nlines",2\n3,b,4`,
      [['1', 'two\nlines', '2'], ['3', 'b', '4']], [2, 4]],
    ['quoted empty field', `${H}\n1,"",2`, [['1', '', '2']], [2]],
    ['empty middle field', `${H}\na,,c`, [['a', '', 'c']], [2]],
    ['trailing comma', `${H}\n1,2,`, [['1', '2', '']], [2]],
    ['trailing newline', `${H}\n1,a,2\n`, [['1', 'a', '2']], [2]],
    ['no trailing newline', `${H}\n1,a,2`, [['1', 'a', '2']], [2]],
    ['blank lines mid-file and at end', `${H}\n\n1,a,2\n\n\n3,b,4\n\n\n`, [['1', 'a', '2'], ['3', 'b', '4']], [3, 6]],
    ['ragged rows pass through', `${H}\n1,a\n1,a,2,3`, [['1', 'a'], ['1', 'a', '2', '3']], [2, 3]],
    ['fields trimmed', `${H}\n 1 , a ,2 `, [['1', 'a', '2']], [2]],
  ])('%s', (_n, text, rows, lines) => {
    const r = parseCsvText(text);
    expect(r.headers).toEqual(['D', 'N', 'A']);
    expect(r.rows).toEqual(rows);
    expect(r.lines).toEqual(lines);
  });

  it('a quoted header after a BOM yields the bare name (BOM not left inside the quote)', () => {
    expect(parseCsvText('\uFEFF"D","N","A"\n1,a,2').headers).toEqual(['D', 'N', 'A']);
  });

  it('a lone CR inside a quoted field counts as a line break for later row lines', () => {
    const r = parseCsvText(`${H}\n1,"a\rb",2\n3,b,4`);
    expect(r.rows).toEqual([['1', 'a\rb', '2'], ['3', 'b', '4']]);
    expect(r.lines).toEqual([2, 4]);
  });

  it('a single-column record that is only whitespace or a quoted empty string is dropped as blank (intentional)', () => {
    const r = parseCsvText(`${H}\n1,a,2\n"" \n   \n""\n3,b,4`);
    expect(r.rows).toEqual([['1', 'a', '2'], ['3', 'b', '4']]);
    expect(r.lines).toEqual([2, 6]);
  });

  it('header-only file has no rows', () => {
    expect(parseCsvText(`${H}\n`)).toEqual({ headers: ['D', 'N', 'A'], rows: [], lines: [] });
  });

  it.each(['', '   ', '\n\n', ' \r\n \n'])('empty or whitespace-only %j gives no headers or rows', (t) => {
    expect(parseCsvText(t)).toEqual({ headers: [], rows: [], lines: [] });
  });

  it('parses a 1 MB field', () => {
    const big = 'x'.repeat(1024 * 1024);
    const r = parseCsvText(`${H}\n1,"${big}",2`);
    expect(r.rows[0][1]).toHaveLength(big.length);
  });

  it('throws naming the start line of an unterminated quote', () => {
    expect(() => parseCsvText(`${H}\n1,a,2\n3,"oops,4\n5,b,6`)).toThrow('CSV has an unterminated quote starting on line 3');
  });
});

describe('parseCSV (file)', () => {
  const { csv } = useTempCsv('parsecsv-');

  it('keeps fileName and hashes the raw bytes including the BOM', () => {
    const text = '\uFEFFD,N,A\r\n1,a,2\r\n';
    const p = csv(text, 'stmt.csv');
    const r = parseCSV(p);
    expect(r.fileName).toBe('stmt.csv');
    expect(r.fileHash).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    expect(r.headers).toEqual(['D', 'N', 'A']);
    expect(r.rows).toEqual([['1', 'a', '2']]);
  });

  it('throws on an unterminated quote rather than silently dropping rows', () => {
    expect(() => parseCSV(csv('D,N\n1,"never closed\n2,b\n'))).toThrow(/unterminated quote starting on line 2/);
  });
});
