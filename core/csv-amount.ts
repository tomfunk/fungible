import type { ImportConfig } from './accounts.js';

// Pure CSV-amount-resolution helper, split out of accounts.ts so the browser
// (gui renderer) bundle can import it without pulling in db.ts (and its
// transitive Node-only deps like crypto.ts) -- accounts.ts re-exports this
// for existing `from './accounts.js'` importers (tui).

export type CsvAmountConfig = Pick<ImportConfig, 'amountMode' | 'amountCol' | 'debitCol' | 'creditCol' | 'positiveIsInflow'>;

/** Resolve a CSV row's transaction amount per the column mapping. Assumes a
 *  fully-chosen `cfg` -- callers (import preview UIs) are responsible for
 *  guarding the "columns not yet chosen" case before calling this. */
export function resolveCsvAmount(row: string[], cfg: CsvAmountConfig): number {
  if (cfg.amountMode === 'split') {
    const debit  = parseFloat(row[cfg.debitCol!]  || '0') || 0;
    const credit = parseFloat(row[cfg.creditCol!] || '0') || 0;
    return debit > 0 ? debit : -credit;
  }
  const raw = parseFloat(row[cfg.amountCol!] || '0') || 0;
  return cfg.positiveIsInflow ? -raw : raw;
}
