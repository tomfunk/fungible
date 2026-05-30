import React, { createContext, useContext, useEffect, useState } from 'react';
import { onRefresh } from '../core/refresh.js';

const Ctx = createContext(0);

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(0);
  useEffect(() => onRefresh(() => setKey((k) => k + 1)), []);
  return <Ctx.Provider value={key}>{children}</Ctx.Provider>;
}

export function useRefreshKey(): number {
  return useContext(Ctx);
}
