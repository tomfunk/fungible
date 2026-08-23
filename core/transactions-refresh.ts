import { getPlaidClient, plaidErrorMessage } from './plaid.js';
import { db } from './db.js';
import { decryptToken } from './crypto.js';
import { syncTransactions } from './sync.js';
import {
  POLL_DELAYS_MS, type RefreshProgress, type RefreshResult,
} from './transactions-refresh-format.js';

// Pure progress types, POLL_DELAYS_MS, and the describe* formatters live in the
// node-free core/transactions-refresh-format.ts so the GUI renderer can import
// them; re-exported here for existing callers.
export {
  POLL_DELAYS_MS, describeRefreshProgress, describeRefreshResult,
} from './transactions-refresh-format.js';
export type { RefreshProgress, RefreshResult } from './transactions-refresh-format.js';

/**
 * On-demand transaction refresh for one Plaid item.
 *
 * `/transactions/refresh` asks Plaid to go poll the bank right now instead of
 * waiting for its next scheduled extraction. The 200 means the extraction was
 * *queued*, not that it finished — Plaid signals completion with a webhook, and
 * this app has none. So the only completion signal available is
 * /transactions/sync eventually returning something, which is what the polling
 * below does.
 *
 * Two consequences worth keeping in mind when changing this file:
 *   - "no new transactions" and "refresh still running" are indistinguishable
 *     from here. Never report the refresh as complete; report what sync returned.
 *   - refresh fetches the *newest* transactions. It does not widen the item's
 *     history window (fixed at item creation, and update mode cannot change it),
 *     so it can only recover recent transactions, never old ones.
 *
 * Plaid bills per /transactions/refresh call on most plans, so the request is
 * made exactly once per invocation; only the free /transactions/sync is polled.
 *
 * Calls `syncTransactions` directly rather than going through `syncAll`: this is
 * inherently one-item work, and syncAll's 15-minute debounce would skip every
 * check after the first.
 */

/** Resolves true when the full delay elapsed, false when `signal` aborted first. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Requests an on-demand refresh for `itemId`, then polls /transactions/sync on a
 * backoff until something lands, the checks run out, or `signal` aborts.
 *
 * Returns rather than throws for the expected failures (unknown item, Plaid
 * rejecting the refresh, the item failing to sync) so a caller can render one
 * status line for every outcome.
 */
export async function refreshTransactions(
  itemId: string,
  opts: { onProgress?: (p: RefreshProgress) => void; signal?: AbortSignal } = {},
): Promise<RefreshResult> {
  const { onProgress, signal } = opts;
  const result: RefreshResult = {
    itemId, added: 0, modified: 0, removed: 0, checks: 0, cancelled: false, syncResults: [],
  };

  const itemRes = await db.execute({
    sql: 'SELECT access_token FROM plaid_items WHERE item_id = ?',
    args: [itemId],
  });
  if (itemRes.rows.length === 0) {
    return { ...result, error: `No linked institution found for item ${itemId}.` };
  }
  const accessToken = decryptToken((itemRes.rows[0] as unknown as { access_token: string }).access_token);

  onProgress?.({ phase: 'requesting' });
  try {
    await getPlaidClient().transactionsRefresh({ access_token: accessToken });
  } catch (err) {
    // Covers the ones users actually hit: Plaid not configured, the plan not
    // including on-demand refresh, the institution not supporting it, a rate
    // limit, and an item needing update mode.
    return { ...result, error: plaidErrorMessage(err) };
  }

  const attempts = POLL_DELAYS_MS.length;
  for (let i = 0; i < attempts; i++) {
    const attempt = i + 1;
    const delayMs = POLL_DELAYS_MS[i]!;

    onProgress?.({ phase: 'waiting', attempt, attempts, until: Date.now() + delayMs });
    if (!(await sleep(delayMs, signal))) {
      result.cancelled = true;
      return result;
    }

    onProgress?.({ phase: 'checking', attempt, attempts });
    result.checks = attempt;
    try {
      const sync = await syncTransactions(accessToken, itemId,
        (step) => onProgress?.({ phase: 'sync', attempt, attempts, step }));

      result.added += sync.added;
      result.modified += sync.modified;
      result.removed += sync.removed;
      result.syncResults = [{ itemId, ...sync, skipped: false }];

      // `modified` counts too: a refresh that only flips pending → posted still
      // means the extraction landed, and there's nothing more to wait for.
      if (sync.added > 0 || sync.modified > 0) return result;
    } catch (err) {
      // A failing item won't start working on the next check — stop and report.
      const error = plaidErrorMessage(err);
      result.syncResults = [{ itemId, added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error }];
      return { ...result, error };
    }
  }

  return result;
}
