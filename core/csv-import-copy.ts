export type CsvSkipReason = 'bad_amount' | 'empty_amount' | 'bad_date' | 'missing_name' | 'duplicate';

/** `rowIndex` is 0-based among data rows (part of stored ids); `line` is the 1-based source line (always set by importCsvTransactions; optional so UI fixtures may omit it). */
export type CsvSkippedRow = { rowIndex: number; line?: number; reason: CsvSkipReason };

/** Plain-language label for each skip reason, shared by every surface. */
export const CSV_SKIP_COPY: Record<CsvSkipReason, string> = {
  bad_amount: 'unreadable amount (EU-format amounts like 1.234,56 are skipped)',
  empty_amount: 'blank amount',
  bad_date: 'invalid date',
  missing_name: 'missing description',
  duplicate: 'already imported',
};

const ORDER: CsvSkipReason[] = ['bad_amount', 'empty_amount', 'bad_date', 'missing_name', 'duplicate'];

/** e.g. "2 unreadable amount (...), 1 invalid date"; empty string when none. */
export function summarizeCsvSkips(skipped: CsvSkippedRow[]): string {
  const counts = new Map<CsvSkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return ORDER.filter((r) => counts.has(r)).map((r) => `${counts.get(r)} ${CSV_SKIP_COPY[r]}`).join(', ');
}
