import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

// `key` bumps whenever data changed somewhere the currently-visible screen
// might not otherwise hear about: originally just the main-process 'refresh'
// push (core/refresh.ts notifyChange, e.g. an MCP/agent tool mutating data
// out-of-band); now also bump-able from the renderer itself via
// useBumpRefresh(), used by useSync() so a sync triggered from the shared
// FilterBar (mounted outside every screen's own component tree) still causes
// whichever of Dashboard/Transactions/Trends is on screen to refetch.
type RefreshCtx = { key: number; bump: () => void };

const RefreshContext = createContext<RefreshCtx>({ key: 0, bump: () => {} });

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(0);
  const bump = useCallback(() => setKey((k) => k + 1), []);
  useEffect(() => window.__bridge.on('refresh', bump), [bump]);
  return <RefreshContext.Provider value={{ key, bump }}>{children}</RefreshContext.Provider>;
}

export function useRefreshKey(): number {
  return useContext(RefreshContext).key;
}

export function useBumpRefresh(): () => void {
  return useContext(RefreshContext).bump;
}
