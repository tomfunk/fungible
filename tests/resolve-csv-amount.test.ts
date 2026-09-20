import { describe, it, expect, vi } from 'vitest';

// resolveCsvAmount is pure and needs no db, but core/accounts.ts imports
// core/db.ts at module scope (which opens a real libsql client against
// DATA_DIR) -- mock it like every other test touching core/accounts.js so
// this stays isolated from the real ~/.fungible data.
vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { resolveCsvAmount } from '../core/accounts.js';
import { makeCsvRow, makeSplitCsvRow } from './helpers/makeCsvRow.js';

describe('resolveCsvAmount', () => {
  describe('split mode (separate debit/credit columns)', () => {
    const cfg = makeSplitCsvRow();

    it('uses the debit column as a positive (outflow) amount when present', () => {
      expect(resolveCsvAmount(['1/1/24', 'Coffee', '4.50', ''], cfg)).toBe(4.5);
    });

    it('negates the credit column (inflow) when debit is absent/zero', () => {
      expect(resolveCsvAmount(['1/1/24', 'Refund', '0', '20.00'], cfg)).toBe(-20);
      expect(resolveCsvAmount(['1/1/24', 'Refund', '', '20.00'], cfg)).toBe(-20);
    });

    it('treats blank/unparseable cells as 0', () => {
      expect(resolveCsvAmount(['1/1/24', 'x', '', ''], cfg)).toBe(-0);
    });
  });

  describe('single mode (one amount column)', () => {
    it('passes the raw amount through when positiveIsInflow is false', () => {
      const cfg = makeCsvRow({ positiveIsInflow: false });
      expect(resolveCsvAmount(['1/1/24', 'Coffee', '4.50'], cfg)).toBe(4.5);
      expect(resolveCsvAmount(['1/1/24', 'Refund', '-20.00'], cfg)).toBe(-20);
    });

    it('flips the sign when positiveIsInflow is true', () => {
      const cfg = makeCsvRow({ positiveIsInflow: true });
      expect(resolveCsvAmount(['1/1/24', 'Deposit', '20.00'], cfg)).toBe(-20);
      expect(resolveCsvAmount(['1/1/24', 'Purchase', '-4.50'], cfg)).toBe(4.5);
    });

    it('treats a blank/unparseable cell as 0', () => {
      const cfg = makeCsvRow({ positiveIsInflow: false });
      expect(resolveCsvAmount(['1/1/24', 'x', ''], cfg)).toBe(0);
    });
  });
});
