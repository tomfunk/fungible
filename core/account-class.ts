// Net-worth account classification, shared by every balance surface: the SQL
// CASE expressions in queries.ts/health.ts, getBalances (agent-context), and the
// TUI/GUI Net Worth screens. Kept dependency-free so the GUI renderer can import
// it without pulling in the database layer.

export const isAssetAccount = (a: { type: string; balance: number }): boolean =>
  a.type === 'depository' || a.type === 'investment' || (a.type === 'other' && a.balance > 0);

export const isLiabilityAccount = (a: { type: string }): boolean => a.type === 'credit';
