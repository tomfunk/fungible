import type { Client } from '@libsql/client';

let seq = 0;

/**
 * Inserts a plaid_items row. The token is stored PLAINTEXT on purpose:
 * core/crypto.ts decryptToken passes any value that does not have exactly two
 * ':' straight through (legacy-token path), so syncAll's decryptToken(...)
 * works with no key file and no mocking. Do not use a token containing ':'.
 * The decrypted token is what reaches the fake Plaid client, so a test can
 * assert `plaid.transactionsSync.mock.calls[0][0].access_token`.
 *
 * `lastSyncedAt` is epoch ms (syncAll's 15-minute debounce reads it); pair it
 * with useFixedClock to make debounce tests deterministic.
 */
export async function seedPlaidItem(
  db: Client,
  itemId: string,
  opts: { accessToken?: string; institutionName?: string | null; lastSyncedAt?: number | null; daysRequested?: number | null } = {},
): Promise<{ itemId: string; accessToken: string }> {
  const accessToken = opts.accessToken ?? `access-${itemId}`;
  await db.execute({
    sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested) VALUES (?, ?, ?, ?, ?)',
    args: [itemId, accessToken, opts.institutionName ?? null, opts.lastSyncedAt ?? null, opts.daysRequested ?? null],
  });
  return { itemId, accessToken };
}

export interface TxRow {
  id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  category: string | null;
  raw_category: string | null;
  pending: 0 | 1;
  manual_category: string | null;
  display_name: string | null;
  ignored: 0 | 1;
  source: 'plaid' | 'csv' | 'manual' | null;
  import_id: number | null;
  dedup_key: string | null;
  original_date: string | null;
}

/**
 * Inserts one transactions row and returns it as written. Defaults give a
 * plain posted Plaid-source expense; override anything (source, manual_category,
 * display_name, ignored, pending, original_date, ...). `pending` and `ignored`
 * accept booleans. Each call without `id` gets a fresh one. Does not create the
 * account (transactions has no FK to accounts; add one if the test joins on it).
 */
export async function seedTx(
  db: Client,
  overrides: Partial<Omit<TxRow, 'pending' | 'ignored'>> & { pending?: boolean | 0 | 1; ignored?: boolean | 0 | 1 } = {},
): Promise<TxRow> {
  seq++;
  const row: TxRow = {
    id: `seed-tx-${seq}`,
    account_id: 'acct-1',
    date: '2025-01-01',
    name: 'Test Merchant',
    merchant_name: null,
    amount: 10,
    category: null,
    raw_category: null,
    manual_category: null,
    display_name: null,
    source: 'plaid',
    import_id: null,
    dedup_key: null,
    original_date: null,
    ...overrides,
    pending: overrides.pending ? 1 : 0,
    ignored: overrides.ignored ? 1 : 0,
  };
  await db.execute({
    sql: `INSERT INTO transactions
            (id, account_id, date, name, merchant_name, amount, category, raw_category, pending,
             manual_category, display_name, ignored, source, import_id, dedup_key, original_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [row.id, row.account_id, row.date, row.name, row.merchant_name, row.amount, row.category, row.raw_category,
      row.pending, row.manual_category, row.display_name, row.ignored, row.source, row.import_id, row.dedup_key, row.original_date],
  });
  return row;
}
