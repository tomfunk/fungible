import type { Transaction } from 'plaid';

let seq = 0;

/**
 * Builds a Plaid /transactions/sync transaction (the `added` / `modified`
 * element shape core/sync.ts reads). Only the fields sync uses are modelled;
 * the rest of Plaid's type is cast away. Each call without `transaction_id`
 * gets a fresh one.
 *
 *   makePlaidTx({ pending: true })
 *   makePlaidTx({ transaction_id: 'p1', pending: false })   // pending -> posted
 *   makePlaidTx({ primaryCategory: 'FOOD_AND_DRINK' })             // personal_finance_category.primary
 *
 * Plaid sign convention: positive amount = money out.
 */
export function makePlaidTx(
  overrides: Partial<Transaction> & { primaryCategory?: string | null } = {},
): Transaction {
  seq++;
  const { primaryCategory, ...rest } = overrides;
  return {
    transaction_id: `plaid-tx-${seq}`,
    account_id: 'acct-1',
    date: '2025-01-01',
    name: 'Test Merchant',
    merchant_name: null,
    amount: 10,
    pending: false,
    personal_finance_category: primaryCategory === null ? null : { primary: primaryCategory ?? 'GENERAL_MERCHANDISE' },
    ...rest,
  } as unknown as Transaction;
}

/** Plaid account entry for makeFakePlaid({ accounts }): balances.current may be null. */
export function makePlaidAccount(
  overrides: { account_id?: string; name?: string; type?: string; subtype?: string | null; mask?: string | null; current?: number | null | undefined } = {},
) {
  // 'current' in overrides: an explicit undefined/null is kept (Plaid can omit or null a
  // balance); only a key that was not passed gets the default of 100.
  const { current: _c, ...rest } = overrides;
  const current = 'current' in overrides ? overrides.current : 100;
  return {
    account_id: 'acct-1',
    name: 'Checking',
    type: 'depository',
    subtype: 'checking',
    mask: '0000',
    ...rest,
    balances: { current },
  };
}
