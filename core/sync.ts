import { getPlaidClient } from './plaid.js';
import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { applyNameRulesWithRules, loadNameRules } from './rename.js';
import { deduplicateCsvVsPlaid } from './dedup.js';
import { decryptToken } from './crypto.js';
import type { Transaction } from 'plaid';

export async function syncTransactions(accessToken: string, itemId: string) {
  const cursorRes = await db.execute({
    sql: 'SELECT cursor FROM sync_state WHERE account_id = ?',
    args: [itemId],
  });
  let cursor = cursorRes.rows.length > 0
    ? (cursorRes.rows[0] as unknown as { cursor: string }).cursor
    : undefined;

  let added: Transaction[] = [];
  let modified: Transaction[] = [];
  let removedIds: string[] = [];
  let hasMore = true;

  while (hasMore) {
    const response = await getPlaidClient().transactionsSync({ access_token: accessToken, cursor });
    const data = response.data;
    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removedIds = removedIds.concat(data.removed.map((r) => r.transaction_id));
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  // Upsert accounts and snapshot balances
  const accountsResponse = await getPlaidClient().accountsGet({ access_token: accessToken });
  const today = new Date().toISOString().slice(0, 10);
  await db.batch(
    accountsResponse.data.accounts.flatMap((acct) => {
      const rows: { sql: string; args: (string | number | null)[] }[] = [
        {
          sql: `INSERT INTO accounts (id, name, type, subtype, mask)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
          args: [acct.account_id, acct.name, acct.type, acct.subtype ?? null, acct.mask ?? null],
        },
      ];
      const balance = acct.balances.current;
      if (balance !== null && balance !== undefined) {
        rows.push({
          sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
                ON CONFLICT(account_id, date) DO UPDATE SET balance=excluded.balance`,
          args: [acct.account_id, balance, today],
        });
      }
      return rows;
    }),
    'write',
  );

  // Load rules once for the batch
  const [catRules, nameRules] = await Promise.all([loadCategoryRules(), loadNameRules()]);

  // Upsert added + modified
  if (added.length > 0 || modified.length > 0) {
    await db.batch(
      [...added, ...modified].map((tx) => {
        const rawCategory = tx.personal_finance_category?.primary ?? null;
        const category = categorizeWithRules(catRules, tx.name, tx.merchant_name ?? null, rawCategory, tx.amount);
        const displayName = applyNameRulesWithRules(nameRules, tx.name, tx.amount);
        return {
          sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, pending, display_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  date=excluded.date, name=excluded.name, merchant_name=excluded.merchant_name,
                  amount=excluded.amount,
                  category=COALESCE(manual_category, excluded.category),
                  raw_category=excluded.raw_category,
                  pending=excluded.pending,
                  display_name=excluded.display_name`,
          args: [
            tx.transaction_id, tx.account_id, tx.date, tx.name,
            tx.merchant_name ?? null, tx.amount, category, rawCategory,
            tx.pending ? 1 : 0,
            displayName !== tx.name ? displayName : null,
          ],
        };
      }),
      'write',
    );
  }

  // Remove deleted
  if (removedIds.length > 0) {
    const placeholders = removedIds.map(() => '?').join(',');
    await db.execute({ sql: `DELETE FROM transactions WHERE id IN (${placeholders})`, args: removedIds });
  }

  // Save cursor and last_synced_at
  await db.batch([
    {
      sql: `INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)
            ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor`,
      args: [itemId, cursor ?? null],
    },
    {
      sql: 'UPDATE plaid_items SET last_synced_at = ? WHERE item_id = ?',
      args: [Date.now(), itemId],
    },
  ], 'write');

  const dupes = await deduplicateCsvVsPlaid();
  return { added: added.length, modified: modified.length, removed: removedIds.length, dupes };
}

const DEBOUNCE_MS = 15 * 60 * 1000;

export async function syncAll(force = false) {
  const itemsRes = await db.execute('SELECT item_id, access_token, last_synced_at FROM plaid_items');
  const items = itemsRes.rows as unknown as {
    item_id: string; access_token: string; last_synced_at: number | null;
  }[];

  const results = [];
  for (const item of items) {
    if (!force && item.last_synced_at && Date.now() - Number(item.last_synced_at) < DEBOUNCE_MS) {
      results.push({ itemId: item.item_id, added: 0, modified: 0, removed: 0, dupes: 0, skipped: true });
      continue;
    }
    const result = await syncTransactions(decryptToken(item.access_token), item.item_id);
    results.push({ itemId: item.item_id, ...result, skipped: false });
  }
  return results;
}
