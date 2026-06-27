import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAccountsWithBalances, getNetWorthHistory, type AccountBalance, type NetWorthPeriod } from '../core/queries.js';
import { isAssetAccount, isLiabilityAccount } from '../core/account-class.js';
import type { Screen } from './App.js';
import { fmt, fmtSigned, bar, truncate, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, MONTHS, SUBTYPE_DISPLAY, C_POSITIVE, C_NEGATIVE, C_ACCENT } from './ui.js';
import { usePagination, PageHeader } from './components/index.js';
import { useRefreshKey } from './RefreshContext.js';

const BAR_WIDTH = 32;
const PAGE = 20;

type ViewMode = 'accounts' | 'types';
type NWRange = 'week' | 'month' | 'quarter' | 'year';
const NW_RANGES: NWRange[] = ['week', 'month', 'quarter', 'year'];
const NW_RANGE_LABELS: Record<NWRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

type TypeBalance = { label: string; balance: number };

function groupByType(accs: AccountBalance[]): TypeBalance[] {
  const map = new Map<string, number>();
  for (const a of accs) {
    const raw = a.subtype ?? a.type;
    const key = SUBTYPE_DISPLAY[raw] ?? raw;
    map.set(key, (map.get(key) ?? 0) + a.balance);
  }
  return [...map.entries()]
    .map(([label, balance]) => ({ label, balance }))
    .sort((a, b) => b.balance - a.balance);
}

function periodLabel(period: string, range: NWRange): string {
  if (range === 'year') return period;
  if (range === 'quarter') {
    const [y, q] = period.split('-');
    return `${q} ${y}`;
  }
  if (range === 'month') {
    const [y, m] = period.split('-');
    return `${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  // week: '2024-W22' → 'W22 2024'
  const [y, w] = period.split('-');
  return `${w} ${y}`;
}

export function NetWorth({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [rows,     setRows]     = useState<NetWorthPeriod[]>([]);
  const [view,   setView]   = useState<ViewMode>('accounts');
  const [range,  setRange]  = useState<NWRange>('month');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    void getAccountsWithBalances().then(({ accounts: a }) => setAccounts(a));
  }, [refreshKey]);

  useEffect(() => {
    void getNetWorthHistory(range).then((r) => {
      setRows(r);
      setCursor(Math.max(0, r.length - 1));
    });
  }, [range, refreshKey]);

  useInput((input, key) => {
    if (key.tab)      { setView((v) => v === 'accounts' ? 'types' : 'accounts'); return; }
    if (key.escape) { onNavigate('dashboard'); return; }
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (input === 'r') {
      setRange((r) => NW_RANGES[(NW_RANGES.indexOf(r) + 1) % NW_RANGES.length]);
      return;
    }
    handleNavKey(input, 'networth', onNavigate);
  }, { isActive: isActive !== false });

  const included = accounts.filter((a) => !a.excluded);
  const excluded = accounts.filter((a) => a.excluded);

  const assets      = included.filter(isAssetAccount);
  const liabilities = included.filter(isLiabilityAccount);

  const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const netWorth         = totalAssets - totalLiabilities;

  const exclNet =
    excluded.filter(isAssetAccount).reduce((s, a) => s + a.balance, 0) -
    excluded.filter(isLiabilityAccount).reduce((s, a) => s + a.balance, 0);

  const maxNet     = Math.max(...rows.map((r) => Math.abs(r.net_worth)), 1);
  const hasHistory = rows.length > 0;

  const assetTypes     = groupByType(assets);
  const liabilityTypes = groupByType(liabilities);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  const AMT_W  = 14;
  const NAME_W = Math.max(14, inner - AMT_W - 16);

  const { visible, pageStart } = usePagination(rows, cursor, PAGE);
  const labelW    = range === 'year' ? 4 : range === 'quarter' ? 7 : range === 'month' ? 8 : 12;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="networth" showHints={showHints} />

      <Box marginTop={1}><Text bold>Net Worth</Text></Box>
      {showHints && <Text dimColor>[Tab] {view === 'accounts' ? 'by type' : 'by account'}  ·  [r] range  ·  ↑↓ scroll</Text>}
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
            <Text bold color={netWorth >= 0 ? C_POSITIVE : C_NEGATIVE}>
              {fmtSigned(netWorth).padStart(18)}
            </Text>
          </Box>

          {/* Assets */}
          <Box flexDirection="column">
            <Text bold color={C_POSITIVE}>Assets</Text>
            {view === 'accounts' ? assets.map((a) => (
              <Box key={a.name + a.balance} gap={2}>
                <Text dimColor>{truncate(a.nickname ?? a.name, NAME_W).padEnd(NAME_W)}</Text>
                <Text>{fmt(a.balance).padStart(AMT_W)}</Text>
                <Text dimColor>{SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type)}</Text>
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
              <Text bold color={C_POSITIVE}>{fmt(totalAssets).padStart(AMT_W)}</Text>
            </Box>
          </Box>

          {/* Liabilities */}
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={C_NEGATIVE}>Liabilities</Text>
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
              <Text bold color={C_NEGATIVE}>{fmt(totalLiabilities).padStart(AMT_W)}</Text>
            </Box>
          </Box>

          {/* Excluded accounts — carved out, not counted in net worth */}
          {excluded.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>Excluded (not in net worth)</Text>
              {excluded.map((a) => (
                <Box key={a.name + a.balance} gap={2}>
                  <Text dimColor>{truncate(a.nickname ?? a.name, NAME_W).padEnd(NAME_W)}</Text>
                  <Text dimColor>{fmt(a.balance).padStart(AMT_W)}</Text>
                  <Text dimColor>{SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type)}</Text>
                </Box>
              ))}
              <Box gap={2}>
                <Text dimColor>{'─'.repeat(NAME_W)}</Text>
              </Box>
              <Box gap={2}>
                <Text dimColor>{'Excluded total'.padEnd(NAME_W)}</Text>
                <Text dimColor>{fmtSigned(exclNet).padStart(AMT_W)}</Text>
              </Box>
            </Box>
          )}

          {/* History */}
          {hasHistory && (
            <>
              <Box marginTop={1}><Divider /></Box>
              <Box justifyContent="space-between">
                <Text bold>History</Text>
                <Box gap={2}>
                  {NW_RANGES.map((r) => (
                    <Text key={r} color={r === range ? C_ACCENT : undefined} dimColor={r !== range} bold={r === range}>
                      {NW_RANGE_LABELS[r]}
                    </Text>
                  ))}
                  {showHints && <Text dimColor>[r]</Text>}
                </Box>
              </Box>
              <Box flexDirection="column">
                {visible.map((row, i) => {
                  const isSelected = pageStart + i === cursor;
                  return (
                    <Box key={row.period} gap={2}>
                      <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>
                        {periodLabel(row.period, range).padEnd(labelW)}
                      </Text>
                      <Text color={row.net_worth >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor={!isSelected}>
                        {fmtSigned(row.net_worth).padStart(14)}
                      </Text>
                      <Text color={row.net_worth >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor>
                        {bar(row.net_worth, maxNet, BAR_WIDTH)}
                      </Text>
                    </Box>
                  );
                })}
                {rows.length > PAGE && (
                  <Text dimColor>{cursor + 1} / {rows.length}</Text>
                )}
              </Box>
            </>
          )}
        </>
      )}
    </Box>
  );
}
