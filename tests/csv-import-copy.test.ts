import { describe, it, expect } from 'vitest';
import { summarizeCsvSkips, CSV_SKIP_COPY } from '../core/csv-import-copy.js';

describe('summarizeCsvSkips', () => {
  it('is empty when nothing was skipped', () => {
    expect(summarizeCsvSkips([])).toBe('');
  });

  it('counts per reason in a stable order', () => {
    const text = summarizeCsvSkips([
      { rowIndex: 4, reason: 'duplicate' },
      { rowIndex: 1, reason: 'bad_date' },
      { rowIndex: 2, reason: 'bad_amount' },
      { rowIndex: 3, reason: 'bad_amount' },
    ]);
    expect(text).toBe(`2 ${CSV_SKIP_COPY.bad_amount}, 1 ${CSV_SKIP_COPY.bad_date}, 1 ${CSV_SKIP_COPY.duplicate}`);
  });

  it('tells the user EU-format amounts are skipped', () => {
    expect(summarizeCsvSkips([{ rowIndex: 0, reason: 'bad_amount' }])).toMatch(/EU-format/);
  });
});
