import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { readFileSync } from 'node:fs';
import { TypingContext } from './TypingContext.js';
import { Dashboard } from './Dashboard.js';
import { Transactions } from './Transactions.js';
import { Trends } from './Trends.js';
import { NetWorth } from './NetWorth.js';
import { Tags } from './Tags.js';
import { Rules } from './Rules.js';
import { Accounts } from './Accounts.js';
import { Health } from './Health.js';
import { Canvas } from './Canvas.js';
import { Settings } from './Settings.js';
import { Chat } from './Chat.js';
import { RefreshProvider, useRefreshKey } from './RefreshContext.js';
import { SyncStatusProvider, useSyncStatus } from './SyncStatusContext.js';
import { FilterProvider } from './FilterContext.js';
import { FilterPanel } from './FilterPanel.js';
import { getLinkedAccounts } from '../core/queries.js';
import { C_NEGATIVE } from './ui.js';
import type { CanvasSpec } from '../core/canvas-agent.js';
import { CANVAS_SPEC_PATH } from '../core/canvas-history.js';

export type Screen = 'dashboard' | 'transactions' | 'trends' | 'networth' | 'tags' | 'rules' | 'accounts' | 'health' | 'canvas' | 'settings';

// Transient, per-navigation params. The persistent transaction-filtering
// dimensions (categories/accounts/owners/tags) live in the shared FilterContext
// now; what remains here is screen-scoped navigation state.
export type TxFilter = {
  from?: string;
  to?: string;
  search?: string;
  range?: string;   // 'week' | 'month' | 'quarter' | 'year' | 'alltime'
  anchor?: string;  // YYYY-MM-DD — which specific period to land on
  canvasSpec?: string; // JSON-encoded CanvasSpec, used when navigating to 'canvas'
  txType?: 'income' | 'expenses';
  flex?: 'fixed' | 'flexible' | 'discretionary';
  focusCategory?: string; // land on this category's trend (Trends focus, not a filter)
  focusTag?: string;      // land on this tag's detail (Tags focus, not a filter)
  drillFrom?: Screen;     // set when a drill-in pushed a shared-filter level; Esc reverses
                          // the drill as a unit (pop + return here) instead of peeling state
};

function AppInner() {
  const [screen, setScreen]         = useState<Screen>('dashboard');
  const [txFilter, setTxFilter]     = useState<TxFilter>({});
  const [canvasSpec, setCanvasSpec] = useState<CanvasSpec | null>(null);
  const [specKey,    setSpecKey]    = useState(0);
  const [chatFocused, setChatFocused] = useState(false);
  const [screenTyping, setScreenTyping] = useState(false);
  const [showHints, setShowHints]   = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const { exit } = useApp();
  const refreshKey = useRefreshKey();
  const { failures } = useSyncStatus();
  const [acctNames, setAcctNames] = useState<Record<string, string>>({});
  const lastSpecRef = useRef<string>('');

  // Resolve failing item ids to account names for the banner. Only loads when
  // there's something to show; falls back to the item id if a name is missing.
  useEffect(() => {
    if (failures.length === 0) return;
    let live = true;
    void getLinkedAccounts().then((accts) => {
      if (!live) return;
      const m: Record<string, string> = {};
      for (const a of accts) if (a.item_id) m[a.item_id] = a.nickname ?? a.name;
      setAcctNames(m);
    });
    return () => { live = false; };
  }, [failures]);

  useEffect(() => {
    try {
      const raw = readFileSync(CANVAS_SPEC_PATH, 'utf-8');
      if (raw !== lastSpecRef.current) {
        lastSpecRef.current = raw;
        const parsed = JSON.parse(raw);
        setCanvasSpec(parsed);
        setSpecKey((k) => k + 1);
        // only auto-navigate if freshly written (within 30s)
        if (parsed._writtenAt && Date.now() - parsed._writtenAt < 30_000) {
          setScreen('canvas');
        }
      }
    } catch { /* file doesn't exist yet */ }
  }, [refreshKey]);

  function loadSpec(s: CanvasSpec) {
    setCanvasSpec(s);
    setSpecKey((k) => k + 1);
  }

  function navigate(s: Screen, filter?: TxFilter) {
    if (s === 'canvas' && filter?.canvasSpec) {
      try { loadSpec(JSON.parse(filter.canvasSpec)); } catch { /* ignore malformed spec */ }
    }
    setTxFilter(filter ?? {});
    setScreen(s);
  }

  useInput((input) => {
    if (chatFocused || screenTyping || filterOpen) return;
    if (input === 'q') exit();
    if (input === 'h') setShowHints((v) => !v);
    if (input === 'f' && (screen === 'dashboard' || screen === 'transactions' || screen === 'trends')) {
      setFilterOpen(true);
    }
  });

  const screenIsActive = !chatFocused && !filterOpen;

  const currentScreen = (() => {
    switch (screen) {
      case 'dashboard':    return <Dashboard    onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'transactions': return <Transactions onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'trends':       return <Trends       onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'networth':     return <NetWorth     onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'tags':         return <Tags         onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'rules':        return <Rules        onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'accounts':     return <Accounts     onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'health':       return <Health       onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'canvas':       return <Canvas       onNavigate={navigate} onLoadSpec={loadSpec} isActive={screenIsActive} showHints={showHints} spec={canvasSpec} specKey={specKey} />;
      case 'settings':     return <Settings     onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
    }
  })();

  return (
    <TypingContext.Provider value={setScreenTyping}>
      <Box flexDirection="column" height="100%">
        <Box flexGrow={1}>
          {currentScreen}
        </Box>
        {filterOpen && <FilterPanel isActive={filterOpen} onClose={() => setFilterOpen(false)} />}
        {failures.length > 0 && screen !== 'accounts' && (
          <Box paddingX={2}>
            <Text color={C_NEGATIVE}>
              ⚠ Sync failed — {failures.map((f) => `${acctNames[f.itemId] ?? (f.itemId || 'account')}: ${f.error}`).join('  ·  ')}  ·  open Accounts to retry
            </Text>
          </Box>
        )}
        <Chat
          isActive={chatFocused}
          onActivate={() => setChatFocused(true)}
          onDeactivate={() => setChatFocused(false)}
          onNavigate={navigate}
        />
      </Box>
    </TypingContext.Provider>
  );
}

export function App() {
  return (
    <RefreshProvider>
      <SyncStatusProvider>
        <FilterProvider>
          <AppInner />
        </FilterProvider>
      </SyncStatusProvider>
    </RefreshProvider>
  );
}
