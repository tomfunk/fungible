export type BalanceImportSkipReason =
  | 'no_matching_account'
  | 'ambiguous_account'
  | 'newer_than_current'
  | 'future_date'
  | 'invalid_date'
  | 'invalid_amount'
  | 'missing_field'
  | 'user_skipped';

export const BALANCE_IMPORT_SKIP_REASONS: readonly BalanceImportSkipReason[] = [
  'no_matching_account', 'ambiguous_account', 'newer_than_current',
  'future_date', 'invalid_date', 'invalid_amount', 'missing_field', 'user_skipped',
];

/** Plain-language label for each skip reason, shared by every surface. */
export const BALANCE_IMPORT_SKIP_COPY: Record<BalanceImportSkipReason, string> = {
  no_matching_account: 'no matching account',
  ambiguous_account: 'ambiguous account name',
  newer_than_current: 'newer than the current balance',
  future_date: 'dated in the future',
  invalid_date: 'invalid date or amount',
  invalid_amount: 'invalid date or amount',
  missing_field: 'missing field',
  user_skipped: 'skipped by you',
};

/** e.g. "2 no matching account, 1 invalid date or amount"; labels with the same copy merge. Empty when none. */
export function summarizeSkips(skipped: { reason: BalanceImportSkipReason }[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) {
    const label = BALANCE_IMPORT_SKIP_COPY[s.reason];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}`).join(', ');
}
