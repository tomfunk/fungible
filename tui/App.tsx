import React, { useState } from 'react';
import { Box, useInput, useApp } from 'ink';
import { Dashboard } from './Dashboard.js';
import { Transactions } from './Transactions.js';
import { Trends } from './Trends.js';
import { NetWorth } from './NetWorth.js';
import { Tags } from './Tags.js';
import { Rules } from './Rules.js';
import { Accounts } from './Accounts.js';
import { Health } from './Health.js';
import { Chat } from './Chat.js';

export type Screen = 'dashboard' | 'transactions' | 'trends' | 'networth' | 'tags' | 'rules' | 'accounts' | 'health';

export type TxFilter = {
  category?: string;
  from?: string;
  to?: string;
  tag?: string;
  account?: string;
  accountName?: string;
};

export function App() {
  const [screen, setScreen]         = useState<Screen>('dashboard');
  const [txFilter, setTxFilter]     = useState<TxFilter>({});
  const [chatFocused, setChatFocused] = useState(false);
  const [showHints, setShowHints]   = useState(false);
  const { exit } = useApp();

  function navigate(s: Screen, filter?: TxFilter) {
    setTxFilter(filter ?? {});
    setScreen(s);
  }

  useInput((input) => {
    if (chatFocused) return; // chat handles its own input
    if (input === 'q') exit();
    if (input === 'h') setShowHints((v) => !v);
  });

  const screenIsActive = !chatFocused;

  const currentScreen = (() => {
    switch (screen) {
      case 'dashboard':    return <Dashboard    onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'transactions': return <Transactions onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'trends':       return <Trends       onNavigate={navigate} isActive={screenIsActive} initialFilter={txFilter} showHints={showHints} />;
      case 'networth':     return <NetWorth     onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'tags':         return <Tags         onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'rules':        return <Rules        onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'accounts':     return <Accounts     onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
      case 'health':       return <Health       onNavigate={navigate} isActive={screenIsActive} showHints={showHints} />;
    }
  })();

  return (
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
  );
}
