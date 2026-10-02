// Tracks whether any sync is currently in flight, across every entry point:
// the startup background sync (app.ts), the manual "Sync now" button, and
// Accounts' force-sync/resync-cursor/post-Plaid-link-sync actions (the latter
// three all funnel through registry.ts's `sync` namespace, wrapped below via
// withSyncProgress). Deliberately free of any Electron import — like
// core/sync-status.ts, this needs to stay importable from tests/gui, which
// import registry.ts directly against a real in-memory DB with no Electron
// runtime present. The actual main->renderer push lives in
// sync-progress-ipc.ts, mirroring the core/sync-status.ts vs
// sync-status-ipc.ts split.

type Listener = (syncing: boolean) => void;

const listeners = new Set<Listener>();

// A counter, not a boolean: concurrent syncs (e.g. a manual click landing
// while the startup sync is still running) must not let whichever one
// finishes first flip the signal back to "idle" out from under the other.
let active = 0;

export function syncProgressStart(): void {
  active++;
  if (active === 1) emit();
}

export function syncProgressEnd(): void {
  active = Math.max(0, active - 1);
  if (active === 0) emit();
}

export function isSyncInProgress(): boolean {
  return active > 0;
}

export function onSyncProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const syncing = isSyncInProgress();
  for (const listener of listeners) listener(syncing);
}

/** Wraps an async sync call so it's counted for its whole duration, including
 *  rejection — mirrors the try/finally every call site already used around
 *  its own local `syncing` state. */
export async function withSyncProgress<T>(fn: () => Promise<T>): Promise<T> {
  syncProgressStart();
  try {
    return await fn();
  } finally {
    syncProgressEnd();
  }
}
