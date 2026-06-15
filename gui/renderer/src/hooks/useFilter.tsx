import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  EMPTY_FILTER,
  pushFilter,
  popFilter as popFilterCore,
  type Filter,
  type FilterHistory,
} from '../../../../core/filters.js';

// Session-global filter shared across Dashboard, Transactions, and Trends —
// the GUI counterpart of tui/FilterContext.tsx. Not persisted; resets per session.
// Every setFilter pushes the previous value onto a bounded history stack so
// popFilter can step back one level at a time (Esc in Transactions).
//
// `preview` lets the FilterPanel show live results as the user adjusts the
// draft, without touching history: `filter` is `preview ?? committed`, while
// `committed` (== history's current) is what the panel hydrates from and what
// `setFilter` ultimately replaces.

type FilterCtx = {
  filter: Filter;
  committed: Filter;
  setFilter: (f: Filter) => void;
  setPreview: (f: Filter | null) => void;
  popFilter: () => void;
  canPop: boolean;
};

const Ctx = createContext<FilterCtx>({
  filter: EMPTY_FILTER,
  committed: EMPTY_FILTER,
  setFilter: () => {},
  setPreview: () => {},
  popFilter: () => {},
  canPop: false,
});

export function FilterProvider({ initial, children }: { initial?: Filter; children: React.ReactNode }) {
  const [hist, setHist] = useState<FilterHistory>({ current: initial ?? EMPTY_FILTER, stack: [] });
  const [preview, setPreview] = useState<Filter | null>(null);
  const setFilter = useCallback((f: Filter) => setHist((h) => pushFilter(h, f)), []);
  const popFilter = useCallback(() => setHist(popFilterCore), []);
  const value = useMemo<FilterCtx>(
    () => ({
      filter: preview ?? hist.current,
      committed: hist.current,
      setFilter,
      setPreview,
      popFilter,
      canPop: hist.stack.length > 0,
    }),
    [preview, hist, setFilter, popFilter],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilter(): FilterCtx {
  return useContext(Ctx);
}
