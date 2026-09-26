// Net-worth account classification, shared by every balance surface: the SQL
// CASE expressions in queries.ts/health.ts, getBalances (agent-context), and the
// TUI/GUI Net Worth screens. Kept dependency-free so the GUI renderer can import
// it without pulling in the database layer.

export const isAssetAccount = (a: { type: string; balance: number }): boolean =>
  a.type === 'depository' || a.type === 'investment' || (a.type === 'other' && a.balance > 0);

export const isLiabilityAccount = (a: { type: string }): boolean =>
  a.type === 'credit' || a.type === 'loan';

// Investment-account subtypes (lowercased) treated as liquid (taxable
// brokerage-like) vs. tax-advantaged retirement accounts. Shared by
// agent-context's getBalances and health.ts's loadHealthData so the two
// copies of this business rule can't silently drift apart.
export const LIQUID_SUBTYPES = ['brokerage', 'cash isa', 'non-taxable brokerage account'] as const;
export const RETIREMENT_SUBTYPES = ['ira', '401k', 'roth', '403b', '457b', 'hsa', 'roth 401k', 'simple ira', 'sep ira', 'pension'] as const;
