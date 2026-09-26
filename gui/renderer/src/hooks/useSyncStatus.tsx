import React from 'react';
import { api } from '../api.js';
import type { SyncFailure } from '../../../../core/sync-status.js';
import { createLiveContext } from './createLiveContext.js';

type SyncStatusValue = { failures: SyncFailure[]; failingItems: Set<string> };

// Pull once (a background sync may have failed before we subscribed), then
// stay live via the sync-status push. `on` returns its own unsubscribe fn.
const syncStatusCtx = createLiveContext<SyncFailure[]>([], (setValue) => {
  void api.sync.getStatus().then(setValue);
  return window.__bridge.on('sync-status', (f) => setValue(f as SyncFailure[]));
});

export function SyncStatusProvider({ children }: { children: React.ReactNode }) {
  return <syncStatusCtx.Provider>{children}</syncStatusCtx.Provider>;
}

export function useSyncStatus(): SyncStatusValue {
  const failures = syncStatusCtx.useValue();
  // Derived fresh on every call — cheap, and nothing downstream keys off its
  // referential identity (call sites only use .size/.has() during render).
  return { failures, failingItems: new Set(failures.map((f) => f.itemId)) };
}
