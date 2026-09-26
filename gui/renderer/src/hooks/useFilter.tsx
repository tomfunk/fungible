import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
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
//
// This context also carries the search string and filter-panel-open flag —
// both used to live locally in each of Dashboard/Transactions/Trends (search)
// or in FilterBar itself (panel open). Lifting them here is what lets the
// single shared FilterBar (mounted once in App.tsx, outside the screens'
// component trees) hold one search box and one Filter button for all three
// screens, while each screen's own '/' and 'u'/'a' shortcuts can still
// operate it (focusSearch/openFilterPanel) without a prop-drilled ref.

type FilterCtx = {
  filter: Filter;
  committed: Filter;
  setFilter: (f: Filter) => void;
  setPreview: (f: Filter | null) => void;
  popFilter: () => void;
  canPop: boolean;
  search: string;
  setSearch: (s: string) => void;
  registerSearchInput: (el: HTMLInputElement | null) => void;
  focusSearch: () => void;
  blurSearch: () => void;
  filterPanelOpen: boolean;
  setFilterPanelOpen: (open: boolean) => void;
};

const Ctx = createContext<FilterCtx>({
  filter: EMPTY_FILTER,
  committed: EMPTY_FILTER,
  setFilter: () => {},
  setPreview: () => {},
  popFilter: () => {},
  canPop: false,
  search: '',
  setSearch: () => {},
  registerSearchInput: () => {},
  focusSearch: () => {},
  blurSearch: () => {},
  filterPanelOpen: false,
  setFilterPanelOpen: () => {},
});

export function FilterProvider({ initial, children }: { initial?: Filter; children: React.ReactNode }) {
  const [hist, setHist] = useState<FilterHistory>({ current: initial ?? EMPTY_FILTER, stack: [] });
  const [preview, setPreview] = useState<Filter | null>(null);
  const [search, setSearch] = useState('');
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const setFilter = useCallback((f: Filter) => setHist((h) => pushFilter(h, f)), []);
  const popFilter = useCallback(() => setHist(popFilterCore), []);
  const registerSearchInput = useCallback((el: HTMLInputElement | null) => {
    searchInputRef.current = el;
  }, []);
  const focusSearch = useCallback(() => searchInputRef.current?.focus(), []);
  const blurSearch = useCallback(() => searchInputRef.current?.blur(), []);
  const value = useMemo<FilterCtx>(
    () => ({
      filter: preview ?? hist.current,
      committed: hist.current,
      setFilter,
      setPreview,
      popFilter,
      canPop: hist.stack.length > 0,
      search,
      setSearch,
      registerSearchInput,
      focusSearch,
      blurSearch,
      filterPanelOpen,
      setFilterPanelOpen,
    }),
    [preview, hist, setFilter, popFilter, search, registerSearchInput, focusSearch, blurSearch, filterPanelOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilter(): FilterCtx {
  return useContext(Ctx);
}
