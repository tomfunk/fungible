import { fmtTimeAgo } from '../../../../core/fmt.js';

/**
 * Shared "⟳ Sync" button + "synced <time ago>" status text, used by both
 * FilterBar (backed by the shared useSync() hook) and Accounts (backed by
 * its own local syncing/lastSynced state and bespoke forceSync, which keeps
 * its richer per-account failure messaging and institution-scoped extras —
 * only this button+label rendering is shared, not the underlying sync
 * logic). Keeping the wording/behavior in one place is what prevents the
 * two call sites from drifting apart again.
 */
export function SyncControl({
  syncing,
  lastSynced,
  onSync,
  statusClassName,
}: {
  syncing: boolean;
  lastSynced: number | null | undefined;
  onSync: () => void;
  statusClassName?: string;
}) {
  return (
    <>
      <button className="ghostBtn" onClick={onSync} disabled={syncing}>
        {syncing ? 'Syncing…' : '⟳ Sync'}
      </button>
      {!syncing && lastSynced !== undefined && (
        <span className={statusClassName}>{`synced ${fmtTimeAgo(lastSynced ?? null)}`}</span>
      )}
    </>
  );
}
