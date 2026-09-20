import type { AccountBalance } from '../../core/queries.js';

let seq = 0;

/**
 * Builds an AccountBalance-shaped fixture — the account+balance shape
 * returned by core/queries.ts getAccountsWithBalances and consumed by
 * core/health.ts and core/account-class.ts. Each call that doesn't override
 * `id` gets a fresh one, so several accounts can be created in one test
 * without colliding.
 */
export function makeAccount(overrides: Partial<AccountBalance> = {}): AccountBalance {
  seq++;
  return {
    id: `acct-${seq}`,
    name: 'Test Account',
    nickname: null,
    type: 'depository',
    subtype: 'checking',
    balance: 1000,
    excluded: false,
    ...overrides,
  };
}
