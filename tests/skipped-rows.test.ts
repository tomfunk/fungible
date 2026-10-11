import { describe, it, expect } from 'vitest';
import { previewSkipped } from '../core/skipped-rows.js';
import { previewCsvSkips, summarizeCsvSkips, type CsvSkippedRow } from '../core/csv-import-copy.js';
import { previewBalanceSkips, summarizeSkips, type BalanceImportSkipReason } from '../core/balance-import-copy.js';

const csvRows = (n: number): CsvSkippedRow[] =>
  Array.from({ length: n }, (_, i) => ({ rowIndex: i, line: i + 2, reason: 'bad_date' as const }));
const balRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ line: i + 2, reason: 'no_matching_account' as BalanceImportSkipReason }));

describe('skipped-row preview', () => {
  it('is empty when nothing was skipped', () => {
    expect(previewCsvSkips([])).toEqual({ summary: '', shown: [], hiddenCount: 0 });
    expect(previewBalanceSkips([])).toEqual({ summary: '', shown: [], hiddenCount: 0 });
  });

  it('shows everything at exactly the cap', () => {
    const p = previewCsvSkips(csvRows(5));
    expect(p.shown).toHaveLength(5);
    expect(p.hiddenCount).toBe(0);
  });

  it('keeps the first rows in order and counts the rest as hidden', () => {
    const rows = csvRows(8);
    const p = previewCsvSkips(rows);
    expect(p.shown).toEqual(rows.slice(0, 5));
    expect(p.hiddenCount).toBe(3);
    expect(p.summary).toBe(summarizeCsvSkips(rows));
  });

  it('balance variant summarises all rows, not only the shown ones', () => {
    const rows = [...balRows(6), { line: 99, reason: 'future_date' as const }];
    const p = previewBalanceSkips(rows);
    expect(p.shown).toHaveLength(5);
    expect(p.hiddenCount).toBe(2);
    expect(p.summary).toBe(summarizeSkips(rows));
    expect(p.summary).toBe('6 no matching account, 1 dated in the future');
  });

  it('generic helper passes the summary through', () => {
    expect(previewSkipped([1, 2, 3, 4, 5, 6], 'x')).toEqual({ summary: 'x', shown: [1, 2, 3, 4, 5], hiddenCount: 1 });
  });
});
