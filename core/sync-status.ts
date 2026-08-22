import { EventEmitter } from 'node:events';
import type { SyncItemResult } from './sync.js';

// Session-only store for the most recent sync's per-item failures, shared by
// both sync paths (startup sync in tui/index.tsx and the user-triggered sync in
// tui/Accounts.tsx). Mirrors core/refresh.ts: a tiny EventEmitter plus a getter,
// so a React provider that mounts *after* the startup sync resolves can still
// read the current state. Nothing is persisted — it clears on the next sync.

export type SyncFailure = { itemId: string; error: string };

const emitter = new EventEmitter();
let failures: SyncFailure[] = [];

/** Record a sync's outcome. Keeps only the failed items; a clean run clears all. */
export function setSyncResult(results: SyncItemResult[]): void {
  failures = results
    .filter((r): r is SyncItemResult & { error: string } => !!r.error)
    .map((r) => ({ itemId: r.itemId, error: r.error }));
  emitter.emit('status');
}

/** Merge a partial sync's outcome: replaces status for `attemptedItemIds` only,
 *  leaving failures recorded for items this run didn't touch. setSyncResult's
 *  "a clean run clears all" is only correct for a whole-DB sync — a scoped sync
 *  that succeeds must not clear another institution's failure badge. */
export function mergeSyncResult(results: SyncItemResult[], attemptedItemIds: string[]): void {
  const attempted = new Set(attemptedItemIds);
  failures = [
    ...failures.filter((f) => !attempted.has(f.itemId)),
    ...results
      .filter((r): r is SyncItemResult & { error: string } => !!r.error)
      .map((r) => ({ itemId: r.itemId, error: r.error })),
  ];
  emitter.emit('status');
}

/** Current failure snapshot — read by a provider on mount to catch a sync that already resolved. */
export function getSyncFailures(): SyncFailure[] {
  return failures;
}

/** Clear all recorded failures (e.g. manual dismissal). No-op if already empty. */
export function clearSyncFailures(): void {
  if (failures.length === 0) return;
  failures = [];
  emitter.emit('status');
}

export function onSyncStatus(fn: () => void): () => void {
  emitter.on('status', fn);
  return () => { emitter.off('status', fn); };
}
