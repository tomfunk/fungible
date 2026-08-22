import { getPlaidClient, plaidErrorMessage } from './plaid.js';
import { db } from './db.js';
import { decryptToken } from './crypto.js';
import { syncTransactions, describeSyncProgress, type SyncItemResult, type SyncProgress } from './sync.js';

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

/** Waits before each post-refresh sync check. Banks routinely take a minute or
 *  more to answer an on-demand extraction, so the tail is long and the total
 *  budget is a little under four minutes. */
export const POLL_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];

export type RefreshProgress =
  | { phase: 'requesting' }
  // `until` is a wall-clock deadline, not a duration, so a caller can re-render
  // this same step every second and get a live countdown for free.
  | { phase: 'waiting'; attempt: number; attempts: number; until: number }
  | { phase: 'checking'; attempt: number; attempts: number }
  | { phase: 'sync'; attempt: number; attempts: number; step: SyncProgress };

/** Human-readable form of a progress step, shared by every caller that renders it. */
export function describeRefreshProgress(p: RefreshProgress): string {
  switch (p.phase) {
    case 'requesting':
      return 'Asking your bank for new transactions…';
    case 'waiting': {
      const secs = Math.max(0, Math.round((p.until - Date.now()) / 1000));
      // Deliberately "requested", not "complete" — see the module comment.
      return `Refresh requested — next check in ${secs}s (check ${p.attempt} of ${p.attempts})…`;
    }
    case 'checking':
      return `Checking for new transactions (check ${p.attempt} of ${p.attempts})…`;
    case 'sync':
      return describeSyncProgress(p.step);
  }
}

export type RefreshResult = {
  itemId: string;
  /** Totals across every check that ran, not just the last one. */
  added: number;
  modified: number;
  removed: number;
  /** How many sync checks actually ran. 0 means the refresh request itself failed. */
  checks: number;
  /** The caller aborted mid-poll. Counts still reflect the checks that did run. */
  cancelled: boolean;
  /** Set when the refresh request or a sync check failed. */
  error?: string;
  /**
   * The last check's outcome in syncAll's shape, for feeding core/sync-status so
   * a refresh maintains the ⚠ badge like any other sync: a failed check raises
   * it, a clean one clears a stale one. Empty when no check ran — passing an
   * empty list to mergeSyncResult would clear the badge without having earned it.
   */
  syncResults: SyncItemResult[];
};

/** One-line summary of a finished refresh, for the caller's status line. */
export function describeRefreshResult(r: RefreshResult): string {
  const found = [
    r.added > 0 ? `${r.added} new transaction${r.added === 1 ? '' : 's'}` : null,
    r.modified > 0 ? `${r.modified} updated` : null,
  ].filter(Boolean).join(', ');

  if (r.cancelled) {
    return found
      ? `Stopped checking — found ${found}`
      : 'Stopped checking. The refresh may still be running at your bank — press [s] to sync later.';
  }
  if (found) return `Done — ${found}`;
  return 'No new transactions yet — the refresh may still be running at your bank. Try [s] sync again in a few minutes.';
}

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
