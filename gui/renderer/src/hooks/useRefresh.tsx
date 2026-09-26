import React, { useCallback } from 'react';
import { createLiveContext } from './createLiveContext.js';

// `key` bumps whenever data changed somewhere the currently-visible screen
// might not otherwise hear about: originally just the main-process 'refresh'
// push (core/refresh.ts notifyChange, e.g. an MCP/agent tool mutating data
// out-of-band); now also bump-able from the renderer itself via
// useBumpRefresh(), used by useSync() so a sync triggered from the shared
// FilterBar (mounted outside every screen's own component tree) still causes
// whichever of Dashboard/Transactions/Trends is on screen to refetch.
const refreshCtx = createLiveContext<number>(0, (setValue) =>
  window.__bridge.on('refresh', () => setValue((k) => k + 1)),
);

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  return <refreshCtx.Provider>{children}</refreshCtx.Provider>;
}

export function useRefreshKey(): number {
  return refreshCtx.useValue();
}

export function useBumpRefresh(): () => void {
  const setValue = refreshCtx.useSetValue();
  return useCallback(() => setValue((k) => k + 1), [setValue]);
}
