import React, { useState, useEffect, useRef } from 'react';
import { Box, useInput, useApp } from 'ink';
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
import type { CanvasSpec } from '../core/canvas-agent.js';
import { CANVAS_SPEC_PATH } from '../core/canvas-history.js';

export type Screen = 'dashboard' | 'transactions' | 'trends' | 'networth' | 'tags' | 'rules' | 'accounts' | 'health' | 'canvas' | 'settings';

export type TxFilter = {
  category?: string;
  from?: string;
  to?: string;
  tag?: string;
  account?: string;
  accountName?: string;
  search?: string;
  range?: string;   // 'week' | 'month' | 'quarter' | 'year' | 'alltime'
  anchor?: string;  // YYYY-MM-DD — which specific period to land on
  canvasSpec?: string; // JSON-encoded CanvasSpec, used when navigating to 'canvas'
};

function AppInner() {
  const [screen, setScreen]         = useState<Screen>('dashboard');
  const [txFilter, setTxFilter]     = useState<TxFilter>({});
  const [canvasSpec, setCanvasSpec] = useState<CanvasSpec | null>(null);
  const [specKey,    setSpecKey]    = useState(0);
  const [chatFocused, setChatFocused] = useState(false);
  const [screenTyping, setScreenTyping] = useState(false);
  const [showHints, setShowHints]   = useState(false);
  const { exit } = useApp();
  const refreshKey = useRefreshKey();
  const lastSpecRef = useRef<string>('');

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
    if (chatFocused || screenTyping) return;
    if (input === 'q') exit();
    if (input === 'h') setShowHints((v) => !v);
  });

  const screenIsActive = !chatFocused;

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
      <AppInner />
    </RefreshProvider>
  );
}
