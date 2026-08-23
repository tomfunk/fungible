/**
 * Pure sync-progress types and formatting — no node/db/Plaid deps, so the GUI
 * renderer can import it to display steps pushed over IPC. core/sync.ts owns the
 * I/O and re-exports these for existing callers.
 */

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
