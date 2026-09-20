export type BalanceHistoryRow = { account_id: string; balance: number; date: string };

/**
 * Builds a balance_history row, matching the table schema in makeTestDb.ts
 * (account_id, balance, date — PRIMARY KEY (account_id, date)).
 */
export function makeBalanceHistoryRow(overrides: Partial<BalanceHistoryRow> = {}): BalanceHistoryRow {
  return {
    account_id: 'acct-1',
    balance: 1000,
    date: '2026-05-20',
    ...overrides,
  };
}
