import React from 'react';
import { api } from '../api.js';
import { createLiveContext } from './createLiveContext.js';

// Whether any sync is currently running, anywhere: the startup background
// sync, a manual "Sync now" click (FilterBar or Accounts), Accounts'
// resync-cursor action, or the sync that follows linking a new institution —
// all funnel through registry.ts's `sync` namespace (or app.ts's startup
// call), which is what actually flips this. Pulled once on mount (covers a
// sync already running before this provider subscribed — e.g. the startup
// sync starting before the renderer finishes loading), then kept live via
// the sync-progress push. Mirrors useSyncStatus.tsx's pattern exactly.
const syncProgressCtx = createLiveContext<boolean>(false, (setValue) => {
  void api.sync.isSyncing().then(setValue);
  return window.__bridge.on('sync-progress', (syncing) => setValue(syncing as boolean));
});

export function SyncProgressProvider({ children }: { children: React.ReactNode }) {
  return <syncProgressCtx.Provider>{children}</syncProgressCtx.Provider>;
}

export function useSyncProgress(): boolean {
  return syncProgressCtx.useValue();
}
