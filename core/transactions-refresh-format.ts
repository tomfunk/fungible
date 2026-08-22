/**
 * Pure refresh-progress types, constants, and formatting — no node/db/Plaid
 * deps, so the GUI renderer can import them to display progress pushed over IPC.
 * core/transactions-refresh.ts owns the polling and re-exports these.
 */
import { describeSyncProgress, type SyncProgress } from './sync-progress.js';
import type { SyncItemResult } from './sync.js';

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
      // Deliberately "requested", not "complete" — see core/transactions-refresh.ts.
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
