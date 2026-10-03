import type { ImportConfig } from './accounts.js';

// Pure CSV-amount parsing/resolution helpers, split out of accounts.ts so the
// browser (gui renderer) bundle can import them without pulling in db.ts (and
// its transitive Node-only deps like crypto.ts) -- accounts.ts re-exports
// resolveCsvAmount for existing `from './accounts.js'` importers (tui).

export type CsvAmountConfig = Pick<ImportConfig, 'amountMode' | 'amountCol' | 'debitCol' | 'creditCol' | 'positiveIsInflow'>;

export type CsvAmountSkipReason = 'bad_amount' | 'empty_amount';

export type CsvAmountResult =
  | { ok: true; amount: number }
  | { ok: false; reason: CsvAmountSkipReason };

// US-style number: plain digits or comma-grouped thousands, optional decimals.
// A decimal comma ("1234,56", "1.234,56") deliberately fails to match: it is
// ambiguous with a thousands separator, so such rows are skipped, not guessed.
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+`;
const PLAIN = new RegExp(String.raw`^([+-])?\$?([+-])?(${NUM})$`);
const PARENS = new RegExp(String.raw`^\(\s*\$?(${NUM})\s*\)$`);

/** Parse one currency cell. Returns null when it is not a clean US-format
 *  amount (including blank -- callers distinguish blank themselves). */
export function parseCsvAmount(raw: string | undefined | null): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let negative = false;
  let digits: string;
  const paren = PARENS.exec(s);
  if (paren) {
    negative = true;
    digits = paren[1];
  } else {
    const m = PLAIN.exec(s);
    if (!m) return null;
    if (m[1] && m[2]) return null; // "--5", "-$-5"
    negative = (m[1] ?? m[2]) === '-';
    digits = m[3];
  }
  const value = parseFloat(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return (negative ? -value : value) + 0; // + 0 normalises -0 to 0
}

const isBlank = (v: string | undefined) => v === undefined || v.trim() === '';

/** Resolve a CSV row's transaction amount per the column mapping. Assumes a
 *  fully-chosen `cfg` -- callers (import preview UIs) are responsible for
 *  guarding the "columns not yet chosen" case before calling this.
 *  Unparseable or blank amounts are reported, never coerced to 0. */
export function resolveCsvAmount(row: string[], cfg: CsvAmountConfig): CsvAmountResult {
  if (cfg.amountMode === 'split') {
    const debitRaw = row[cfg.debitCol!];
    const creditRaw = row[cfg.creditCol!];
    if (isBlank(debitRaw) && isBlank(creditRaw)) return { ok: false, reason: 'empty_amount' };
    if (!isBlank(debitRaw)) {
      const debit = parseCsvAmount(debitRaw);
      if (debit === null) return { ok: false, reason: 'bad_amount' };
      if (debit !== 0 || isBlank(creditRaw)) return { ok: true, amount: debit };
    }
    const credit = parseCsvAmount(creditRaw);
    if (credit === null) return { ok: false, reason: 'bad_amount' };
    return { ok: true, amount: -credit + 0 };
  }
  const raw = row[cfg.amountCol!];
  if (isBlank(raw)) return { ok: false, reason: 'empty_amount' };
  const v = parseCsvAmount(raw);
  if (v === null) return { ok: false, reason: 'bad_amount' };
  return { ok: true, amount: (cfg.positiveIsInflow ? -v : v) + 0 };
}
