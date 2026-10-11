import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from './useQuery.js';
import { useBumpRefresh } from './useRefresh.js';
import { useSyncProgress } from './useSyncProgress.js';

export type SyncResult = { ok: boolean; message: string };

/**
 * Generic "sync everything" control, shared by the FilterBar (Dashboard,
 * Transactions, Trends) and Accounts' own sync button. Deliberately excludes
 * Accounts' institution-scoped extras — syncNewInstitutions (post-link
 * scoped sync), deleteCursorAndResync, and refresh-progress polling all stay
 * local to Accounts.tsx, which also keeps its own richer per-account failure
 * message (this hook returns a flat "Sync failed: …" string instead).
 *
 * Calls the shared bump() from useRefresh on completion (success or failure)
 * so every useQuery()-backed read across the app — which already depends on
 * the global refresh key — refetches, regardless of which screen triggered
 * the sync or which screen is currently mounted.
 */
export function useSync() {
  const [localSyncing, setLocalSyncing] = useState(false);
  // Also true while ANY sync is running, including one this hook didn't
  // start itself — the startup sync, a Plaid-link follow-up, or a click on
  // Accounts' own sync button — so this screen's "Syncing…" stays accurate
  // no matter what triggered it.
  const globalSyncing = useSyncProgress();
  const syncing = localSyncing || globalSyncing;
  const bump = useBumpRefresh();
  const lastSynced = useQuery(() => api.sync.getLastSyncedAt(), []);

  const forceSync = useCallback(async (): Promise<SyncResult | undefined> => {
    if (syncing) return undefined;
    setLocalSyncing(true);
    try {
      const results = await api.sync.syncAll(true);
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        return { ok: false, message: `Sync failed: ${failed.map((r) => r.error).join('  ·  ')}` };
      }
      const added = results.reduce((s, r) => s + r.added, 0);
      return { ok: true, message: `Sync done — ${added} new transaction${added === 1 ? '' : 's'}` };
    } catch {
      return { ok: false, message: 'Sync failed' };
    } finally {
      setLocalSyncing(false);
      bump();
    }
  }, [syncing, bump]);

  return { syncing, lastSynced, forceSync };
}
