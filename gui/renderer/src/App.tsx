import React, { useEffect, useRef, useState } from 'react';
import type { Screen, TxFilter } from '../../shared/nav.js';
import { SCREEN_KEYS } from '../../shared/nav.js';
import { api } from './api.js';
import { RefreshProvider, useRefreshKey } from './hooks/useRefresh.js';
import { SyncStatusProvider, useSyncStatus } from './hooks/useSyncStatus.js';
import { NavContext } from './hooks/useNav.js';
import { FilterProvider } from './hooks/useFilter.js';
import { UiPrefsProvider } from './hooks/useUiPrefs.js';
import { useScreenKeys, type KeyHandlers } from './hooks/useScreenKeys.js';
import { SideNav } from './components/SideNav.js';
import { ChatDrawer } from './components/ChatDrawer.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { FilterBar } from './components/FilterBar.js';
import { Dashboard } from './screens/Dashboard.js';
import { Transactions } from './screens/Transactions.js';
import { Trends } from './screens/Trends.js';
import { NetWorth } from './screens/NetWorth.js';
import { Accounts } from './screens/Accounts.js';
import { Tags } from './screens/Tags.js';
import { Rules } from './screens/Rules.js';
import { Health } from './screens/Health.js';
import { Canvas } from './screens/Canvas.js';
import { Settings } from './screens/Settings.js';
import styles from './App.module.css';

function AppInner() {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [txFilter, setTxFilter] = useState<TxFilter>({});
  const [navKey, setNavKey] = useState(0);
  const refreshKey = useRefreshKey();
  const { failures } = useSyncStatus();
  const [acctNames, setAcctNames] = useState<Record<string, string>>({});
  const lastSpecRef = useRef('');

  // Resolve failing item ids to account names for the banner; only loads when
  // there's something to show, and falls back to the item id if a name is missing.
  useEffect(() => {
    if (failures.length === 0) return;
    let live = true;
    void api.queries.getLinkedAccounts().then((accts) => {
      if (!live) return;
      const m: Record<string, string> = {};
      for (const a of accts) if (a.item_id) m[a.item_id] = a.nickname ?? a.name;
      setAcctNames(m);
    });
    return () => { live = false; };
  }, [failures]);

  function navigate(s: Screen, filter?: TxFilter) {
    setTxFilter(filter ?? {});
    setScreen(s);
    setNavKey((k) => k + 1); // remount target screen so it re-reads the filter
  }

  // Global digit navigation, same map as the TUI (active when keys toggle is on).
  useScreenKeys(
    Object.fromEntries(
      Object.entries(SCREEN_KEYS).map(([digit, target]) => [digit, () => navigate(target)]),
    ) as KeyHandlers,
  );

  // Auto-open a freshly generated canvas (mirrors tui/App.tsx spec-file watch).
  useEffect(() => {
    void api.canvas.loadCurrentSpec().then((spec) => {
      if (!spec) return;
      const raw = JSON.stringify(spec);
      if (raw === lastSpecRef.current) return;
      const isFirstCheck = lastSpecRef.current === '';
      lastSpecRef.current = raw;
      if (!isFirstCheck && spec._writtenAt && Date.now() - spec._writtenAt < 30_000) {
        navigate('canvas');
      }
    });
  }, [refreshKey]);

  const current = (() => {
    switch (screen) {
      case 'dashboard':
        return <Dashboard key={navKey} />;
      case 'transactions':
        return <Transactions key={navKey} />;
      case 'trends':
        return <Trends key={navKey} />;
      case 'networth':
        return <NetWorth key={navKey} />;
      case 'accounts':
        return <Accounts key={navKey} />;
      case 'tags':
        return <Tags key={navKey} />;
      case 'rules':
        return <Rules key={navKey} />;
      case 'health':
        return <Health key={navKey} />;
      case 'canvas':
        return <Canvas key={navKey} />;
      case 'settings':
        return <Settings key={navKey} />;
    }
  })();

  const filterableScreens: Screen[] = ['dashboard', 'transactions', 'trends'];

  return (
    <NavContext.Provider value={{ screen, txFilter, navigate }}>
      <div className={styles.shell}>
        <SideNav active={screen} onSelect={navigate} />
        <div className={styles.main}>
          {failures.length > 0 && screen !== 'accounts' && (
            <div className={styles.syncBanner}>
              ⚠ Sync failed — {failures.map((f) => `${acctNames[f.itemId] ?? (f.itemId || 'account')}: ${f.error}`).join('  ·  ')}  ·  open Accounts to retry
            </div>
          )}
          {filterableScreens.includes(screen) && <FilterBar />}
          <main className={styles.content}>
            <ErrorBoundary key={`${screen}:${navKey}`}>{current}</ErrorBoundary>
          </main>
          <ChatDrawer />
        </div>
      </div>
    </NavContext.Provider>
  );
}

export function App() {
  return (
    <RefreshProvider>
      <SyncStatusProvider>
        <FilterProvider>
          <UiPrefsProvider>
            <AppInner />
          </UiPrefsProvider>
        </FilterProvider>
      </SyncStatusProvider>
    </RefreshProvider>
  );
}
