import type { ImportConfig } from '../../core/accounts.js';

/**
 * Builds a single-amount-column ImportConfig — the shape core/accounts.ts
 * importCsvTransactions takes, and that the GUI and TUI CSV-import screens
 * both build from column-picker state. tests/imports.test.ts,
 * tests/gui/accounts-imports.test.tsx and tests/tui/accounts-imports.test.tsx
 * each independently hand-rolled an identical `CFG` const with these same
 * defaults; use this instead so the three surfaces share one fixture.
 */
export function makeCsvRow(overrides: Partial<ImportConfig> = {}): ImportConfig {
  return {
    amountMode: 'single',
    dateCol: 0,
    nameCol: 1,
    amountCol: 2,
    debitCol: null,
    creditCol: null,
    positiveIsInflow: false,
    ...overrides,
  };
}

/**
 * Debit/credit-column variant — two separate columns instead of one signed
 * amount column (core/accounts.ts importCsvTransactions, amountMode: 'split').
 */
export function makeSplitCsvRow(overrides: Partial<ImportConfig> = {}): ImportConfig {
  return makeCsvRow({
    amountMode: 'split',
    amountCol: null,
    debitCol: 2,
    creditCol: 3,
    ...overrides,
  });
}
