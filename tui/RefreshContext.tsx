import React, { createContext, useContext, useEffect, useState } from 'react';
import { onRefresh } from '../core/refresh.js';

const RefreshCtx = createContext(0);

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(0);
  useEffect(() => onRefresh(() => setKey((k) => k + 1)), []);
  return <RefreshCtx.Provider value={key}>{children}</RefreshCtx.Provider>;
}

export function useRefreshKey(): number {
  return useContext(RefreshCtx);
}
