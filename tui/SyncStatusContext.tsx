import React, { createContext, useContext, useEffect, useState } from 'react';
import { onSyncStatus, getSyncFailures, type SyncFailure } from '../core/sync-status.js';

type SyncStatusValue = { failures: SyncFailure[]; failingItems: Set<string> };

const SyncStatusCtx = createContext<SyncStatusValue>({ failures: [], failingItems: new Set() });

export function SyncStatusProvider({ children }: { children: React.ReactNode }) {
  const [failures, setFailures] = useState<SyncFailure[]>(() => getSyncFailures());
  useEffect(() => {
    // Re-read on mount in case a sync resolved between the initial render and
    // this subscription, then stay in sync with future emits.
    setFailures(getSyncFailures());
    return onSyncStatus(() => setFailures(getSyncFailures()));
  }, []);
  const value: SyncStatusValue = {
    failures,
    failingItems: new Set(failures.map((f) => f.itemId)),
  };
  return <SyncStatusCtx.Provider value={value}>{children}</SyncStatusCtx.Provider>;
}

export function useSyncStatus(): SyncStatusValue {
  return useContext(SyncStatusCtx);
}
