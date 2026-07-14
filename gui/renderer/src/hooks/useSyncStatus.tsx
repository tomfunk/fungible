import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';
import type { SyncFailure } from '../../../../core/sync-status.js';

type SyncStatusValue = { failures: SyncFailure[]; failingItems: Set<string> };

const SyncStatusContext = createContext<SyncStatusValue>({ failures: [], failingItems: new Set() });

export function SyncStatusProvider({ children }: { children: React.ReactNode }) {
  const [failures, setFailures] = useState<SyncFailure[]>([]);
  useEffect(() => {
    // Pull once (a background sync may have failed before we subscribed), then
    // stay live via the sync-status push. `on` returns its own unsubscribe fn.
    void api.sync.getStatus().then(setFailures);
    return window.__bridge.on('sync-status', (f) => setFailures(f as SyncFailure[]));
  }, []);
  const value: SyncStatusValue = { failures, failingItems: new Set(failures.map((f) => f.itemId)) };
  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>;
}

export function useSyncStatus(): SyncStatusValue {
  return useContext(SyncStatusContext);
}
