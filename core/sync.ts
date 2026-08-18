import { getPlaidClient, plaidErrorMessage } from './plaid.js';
import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { applyNameRulesWithRules, loadNameRules } from './rename.js';
import { applyTagRules } from './tag-rules.js';
import { deduplicateCsvVsPlaid } from './dedup.js';
import { decryptToken } from './crypto.js';
import type { Transaction } from 'plaid';

/**
 * A step within one item's sync, reported as it starts so a caller can show the
 * user what the network is busy with. Every long phase gets an entry; the counts
 * are what's known at that point, not a total.
 */
export type SyncProgress =
  | { phase: 'transactions'; page: number; fetched: number }
  | { phase: 'accounts' }
  | { phase: 'categorize'; count: number }
  | { phase: 'tag-rules'; count: number }
  | { phase: 'remove'; count: number }
  | { phase: 'dedup' };

/** Human-readable form of a progress step, shared by every caller that renders it. */
export function describeSyncProgress(p: SyncProgress): string {
  switch (p.phase) {
    case 'transactions': return `Fetching transactions… ${p.fetched.toLocaleString()} so far`;
    case 'accounts':     return 'Fetching accounts & balances…';
    case 'categorize':   return `Categorizing ${p.count.toLocaleString()} transaction${p.count === 1 ? '' : 's'}…`;
    case 'tag-rules':    return 'Applying tag rules…';
    case 'remove':       return `Removing ${p.count.toLocaleString()} deleted transaction${p.count === 1 ? '' : 's'}…`;
    case 'dedup':        return 'Checking for duplicates…';
  }
}

export type SyncProgressFn = (p: SyncProgress) => void;

export async function syncTransactions(accessToken: string, itemId: string, onProgress?: SyncProgressFn) {
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

  let page = 0;
  while (hasMore) {
    // Reported before the request so the first page doesn't sit silent — a full
    // backfill can spend a long time here on a new item.
    onProgress?.({ phase: 'transactions', page: ++page, fetched: added.length + modified.length });
    const response = await getPlaidClient().transactionsSync({ access_token: accessToken, cursor });
    const data = response.data;
    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removedIds = removedIds.concat(data.removed.map((r) => r.transaction_id));
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  // Upsert accounts and snapshot balances
  onProgress?.({ phase: 'accounts' });
  const accountsResponse = await getPlaidClient().accountsGet({ access_token: accessToken });
  const today = new Date().toISOString().slice(0, 10);
  await db.batch(
    accountsResponse.data.accounts.flatMap((acct) => {
      const rows: { sql: string; args: (string | number | null)[] }[] = [
        {
          sql: `INSERT INTO accounts (id, name, type, subtype, mask, item_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, item_id=excluded.item_id`,
          args: [acct.account_id, acct.name, acct.type, acct.subtype ?? null, acct.mask ?? null, itemId],
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
    onProgress?.({ phase: 'categorize', count: added.length + modified.length });
    await db.batch(
      [...added, ...modified].map((tx) => {
        const rawCategory = tx.personal_finance_category?.primary ?? null;
        const category = categorizeWithRules(catRules, tx.name, tx.merchant_name ?? null, rawCategory, tx.amount, tx.account_id);
        const displayName = applyNameRulesWithRules(nameRules, tx.name, tx.amount, tx.account_id);
        return {
          sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, pending, display_name, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'plaid')
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

    // Apply tag rules to new/changed rows. Suppression keeps removed tags gone,
    // so re-asserting on modified/existing rows is safe.
    onProgress?.({ phase: 'tag-rules', count: added.length + modified.length });
    await applyTagRules({ txIds: [...added, ...modified].map((tx) => tx.transaction_id) });
  }

  // Remove deleted. Clear child rows first: transaction_tags has a FK
  // (transaction_id → transactions.id), so deleting a tagged transaction
  // directly fails with a FOREIGN KEY constraint. tag_rule_suppressions is
  // keyed by transaction_id too (no FK, but clearing it avoids orphan rows).
  // One batch keeps the three deletes atomic.
  if (removedIds.length > 0) {
    onProgress?.({ phase: 'remove', count: removedIds.length });
    const placeholders = removedIds.map(() => '?').join(',');
    await db.batch([
      { sql: `DELETE FROM transaction_tags WHERE transaction_id IN (${placeholders})`, args: removedIds },
      { sql: `DELETE FROM tag_rule_suppressions WHERE transaction_id IN (${placeholders})`, args: removedIds },
      { sql: `DELETE FROM transactions WHERE id IN (${placeholders})`, args: removedIds },
    ], 'write');
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

  // Runs a self-join over the whole transactions table, so it can be the
  // slowest step on a large database even when this item added nothing.
  onProgress?.({ phase: 'dedup' });
  const dupes = await deduplicateCsvVsPlaid();
  return { added: added.length, modified: modified.length, removed: removedIds.length, dupes };
}

/**
 * Forget how far we have consumed an item's /transactions/sync change feed, so
 * the next sync starts from the beginning and Plaid resends every transaction it
 * currently holds as `added`. Pair it with a scoped syncAll(true, [itemId]) to
 * resync immediately.
 *
 * What this recovers is rows *this app* lost while Plaid kept them: an account
 * deleted via deleteAccount (which cascades to its transactions), a row removed
 * by deleteTransaction, or a database rebuilt against a still-live item. Every
 * write in syncTransactions is an upsert, so the resync is idempotent and leaves
 * manual categories and tag suppressions alone.
 *
 * What it cannot recover is anything Plaid no longer has — including the rows we
 * deleted *because* Plaid reported them `removed`. Those are absent from the
 * replayed feed for the same reason they were deleted, so cursor-zero changes
 * nothing about them. Only a relinked item can bring those back, and only if the
 * bank still reports them.
 *
 * Note the corollary, which the confirmation copy warns about: a deliberate
 * deleteTransaction leaves no tombstone, so replaying the feed resurrects rows
 * the user meant to be rid of.
 */
export async function deleteSyncCursor(itemId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM sync_state WHERE account_id = ?', args: [itemId] });
}

const DEBOUNCE_MS = 15 * 60 * 1000;

export type SyncItemResult = {
  itemId: string;
  added: number; modified: number; removed: number; dupes: number;
  skipped: boolean;
  // Set when this item failed to sync; carries the extracted Plaid/error message
  // so callers can report which item broke and why. One item failing does not
  // abort the others.
  error?: string;
};

/**
 * Syncs every Plaid item, or just `itemIds` when given a non-empty list —
 * used right after a link so the new institution syncs immediately instead of
 * waiting for the next launch. Per-item error capture and the debounce are
 * unchanged either way.
 *
 * `onProgress` reports each step as it starts, tagged with the item it belongs
 * to. It's optional so existing callers — including the GUI bridge, where a
 * callback can't cross IPC — are unaffected.
 */
export async function syncAll(
  force = false,
  itemIds?: string[],
  onProgress?: (itemId: string, p: SyncProgress) => void,
): Promise<SyncItemResult[]> {
  const itemsRes = itemIds && itemIds.length > 0
    ? await db.execute({
        sql: `SELECT item_id, access_token, last_synced_at FROM plaid_items
              WHERE item_id IN (${itemIds.map(() => '?').join(', ')})`,
        args: itemIds,
      })
    : await db.execute('SELECT item_id, access_token, last_synced_at FROM plaid_items');
  const items = itemsRes.rows as unknown as {
    item_id: string; access_token: string; last_synced_at: number | null;
  }[];

  const results: SyncItemResult[] = [];
  for (const item of items) {
    if (!force && item.last_synced_at && Date.now() - Number(item.last_synced_at) < DEBOUNCE_MS) {
      results.push({ itemId: item.item_id, added: 0, modified: 0, removed: 0, dupes: 0, skipped: true });
      continue;
    }
    try {
      const result = await syncTransactions(
        decryptToken(item.access_token), item.item_id,
        onProgress && ((p) => onProgress(item.item_id, p)),
      );
      results.push({ itemId: item.item_id, ...result, skipped: false });
    } catch (err) {
      results.push({
        itemId: item.item_id, added: 0, modified: 0, removed: 0, dupes: 0,
        skipped: false, error: plaidErrorMessage(err),
      });
    }
  }
  return results;
}
