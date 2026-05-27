import React from 'react';
import { Box, Text, useInput } from 'ink';
import { getAccountsWithBalances, type AccountBalance, type HistoryRow } from '../core/queries.js';
import type { Screen } from './App.js';
import { fmt, fmtSigned, bar, truncate, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth } from './useTerminalWidth.js';

const BAR_WIDTH = 32;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type TypeBalance = { label: string; balance: number };

type ViewMode = 'accounts' | 'types';

function dateLabel(d: string) {
  const dt = new Date(d + 'T12:00:00');
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()} ${dt.getFullYear()}`;
}

function groupByType(accs: AccountBalance[]): TypeBalance[] {
  const map = new Map<string, number>();
  for (const a of accs) {
    const key = a.subtype ?? a.type;
    map.set(key, (map.get(key) ?? 0) + a.balance);
  }
  return [...map.entries()]
    .map(([label, balance]) => ({ label, balance }))
    .sort((a, b) => b.balance - a.balance);
}

export function NetWorth({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const { accounts, history } = getAccountsWithBalances();
  const [view, setView] = React.useState<ViewMode>('accounts');

  useInput((input, key) => {
    if (key.tab) { setView((v) => v === 'accounts' ? 'types' : 'accounts'); return; }
    if (key.escape || input === '4') { onNavigate('networth'); return; }
    handleNavKey(input, 'networth', onNavigate);
  }, { isActive: isActive !== false });

  const assets      = accounts.filter((a) => a.type === 'depository' || a.type === 'investment' || (a.type === 'other' && a.balance > 0));
  const liabilities = accounts.filter((a) => a.type === 'credit');

  const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const netWorth         = totalAssets - totalLiabilities;

  const current = history[history.length - 1];
  const maxNet  = Math.max(...history.map((r) => Math.abs(r.net)), 1);
  const hasHistory = history.length > 1;

  const assetTypes      = groupByType(assets);
  const liabilityTypes  = groupByType(liabilities);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  const AMT_W  = 14;
  // [name] gap [amount=14] gap [subtype~12] — 2 gaps of 2
  const NAME_W = Math.max(14, inner - AMT_W - 16);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="networth" showHints={showHints} />
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Box>
          <Text bold>Net Worth</Text>
          {current && <Text dimColor>  as of {dateLabel(current.date)}</Text>}
        </Box>
        {showHints && <Text dimColor>[Tab] {view === 'accounts' ? 'by type' : 'by account'}</Text>}
      </Box>
      <Divider />

      {accounts.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>No balance data yet.</Text>
          <Text dimColor>Sync your accounts ([8] accounts → [s]) to populate.</Text>
        </Box>
      ) : (
        <>
          {/* Big net worth number */}
          <Box marginTop={1} marginBottom={1}>
            <Text bold color={netWorth >= 0 ? 'green' : 'red'}>
              {fmtSigned(netWorth).padStart(18)}
            </Text>
          </Box>

          {/* Assets */}
          <Box flexDirection="column">
            <Text bold color="green">Assets</Text>
            {view === 'accounts' ? assets.map((a) => (
              <Box key={a.name + a.balance} gap={2}>
                <Text dimColor>{truncate(a.nickname ?? a.name, NAME_W).padEnd(NAME_W)}</Text>
                <Text>{fmt(a.balance).padStart(AMT_W)}</Text>
                <Text dimColor>{a.subtype ?? a.type}</Text>
              </Box>
            )) : assetTypes.map((t) => (
              <Box key={t.label} gap={2}>
                <Text dimColor>{t.label.padEnd(NAME_W)}</Text>
                <Text>{fmt(t.balance).padStart(AMT_W)}</Text>
              </Box>
            ))}
            <Box gap={2} marginTop={0}>
              <Text dimColor>{'─'.repeat(NAME_W)}</Text>
            </Box>
            <Box gap={2}>
              <Text bold>{'Total assets'.padEnd(NAME_W)}</Text>
              <Text bold color="green">{fmt(totalAssets).padStart(AMT_W)}</Text>
            </Box>
          </Box>

          {/* Liabilities */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="red">Liabilities</Text>
            {view === 'accounts' ? liabilities.map((a) => (
              <Box key={a.name + a.balance} gap={2}>
                <Text dimColor>{truncate(a.nickname ?? a.name, NAME_W).padEnd(NAME_W)}</Text>
                <Text>{fmt(a.balance).padStart(AMT_W)}</Text>
              </Box>
            )) : liabilityTypes.map((t) => (
              <Box key={t.label} gap={2}>
                <Text dimColor>{t.label.padEnd(NAME_W)}</Text>
                <Text>{fmt(t.balance).padStart(AMT_W)}</Text>
              </Box>
            ))}
            <Box gap={2}>
              <Text dimColor>{'─'.repeat(NAME_W)}</Text>
            </Box>
            <Box gap={2}>
              <Text bold>{'Total debt'.padEnd(NAME_W)}</Text>
              <Text bold color="red">{fmt(totalLiabilities).padStart(AMT_W)}</Text>
            </Box>
          </Box>

          {/* History */}
          {hasHistory && (
            <>
              <Box marginTop={1}><Divider /></Box>
              <Text bold>History</Text>
              <Box flexDirection="column">
                {history.map((row) => (
                  <Box key={row.date} gap={2}>
                    <Text dimColor>{dateLabel(row.date).padEnd(16)}</Text>
                    <Text color={row.net >= 0 ? 'green' : 'red'}>
                      {fmtSigned(row.net).padStart(14)}
                    </Text>
                    <Text color={row.net >= 0 ? 'green' : 'red'} dimColor>
                      {bar(row.net, maxNet, BAR_WIDTH)}
                    </Text>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </>
      )}
    </Box>
  );
}
