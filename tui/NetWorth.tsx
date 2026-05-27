import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAccountsWithBalances, type AccountBalance, type HistoryRow } from '../core/queries.js';
import type { Screen } from './App.js';
import { fmt, fmtSigned, bar, truncate, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth, MONTHS, SUBTYPE_DISPLAY, C_POSITIVE, C_NEGATIVE } from './ui.js';

const BAR_WIDTH = 32;
const PAGE = 20;

type ViewMode = 'accounts' | 'types';
type NWRange = 'week' | 'month' | 'quarter' | 'year';
const NW_RANGES: NWRange[] = ['week', 'month', 'quarter', 'year'];
const NW_RANGE_LABELS: Record<NWRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

type TypeBalance = { label: string; balance: number };
type BucketRow = { label: string; date: string; assets: number; liabilities: number; net: number };

function dateLabel(d: string) {
  const dt = new Date(d + 'T12:00:00');
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()} ${dt.getFullYear()}`;
}

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

function bucketHistory(history: HistoryRow[], range: NWRange): BucketRow[] {
  const buckets = new Map<string, HistoryRow[]>();
  for (const row of history) {
    const dt = new Date(row.date + 'T12:00:00');
    const y = dt.getFullYear();
    const m = dt.getMonth() + 1;
    let key: string;
    if (range === 'year') {
      key = `${y}`;
    } else if (range === 'quarter') {
      key = `${y}-Q${Math.ceil(m / 3)}`;
    } else if (range === 'month') {
      key = `${y}-${String(m).padStart(2, '0')}`;
    } else {
      // week: bucket by Monday
      const day = dt.getDay();
      const mon = new Date(dt);
      mon.setDate(dt.getDate() - ((day + 6) % 7));
      key = mon.toISOString().slice(0, 10);
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }

  return [...buckets.entries()]
    .map(([, rows]) => {
      const last = rows[rows.length - 1];
      const dt = new Date(last.date + 'T12:00:00');
      const y = dt.getFullYear();
      const m = dt.getMonth() + 1;
      let label: string;
      if (range === 'year')         label = `${y}`;
      else if (range === 'quarter') label = `Q${Math.ceil(m / 3)} ${y}`;
      else if (range === 'month')   label = `${MONTHS[m - 1]} ${y}`;
      else                          label = dateLabel(last.date);
      return { label, date: last.date, assets: last.assets, liabilities: last.liabilities, net: last.net };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function NetWorth({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const { accounts, history } = getAccountsWithBalances();
  const [view,   setView]   = useState<ViewMode>('accounts');
  const [range,  setRange]  = useState<NWRange>('month');
  const [cursor, setCursor] = useState(0);

  const rows = bucketHistory(history, range);

  // Reset cursor to last row when range changes
  useEffect(() => {
    setCursor(Math.max(0, rows.length - 1));
  }, [range, rows.length]);

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

  const assets      = accounts.filter((a) => a.type === 'depository' || a.type === 'investment' || (a.type === 'other' && a.balance > 0));
  const liabilities = accounts.filter((a) => a.type === 'credit');

  const totalAssets      = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const netWorth         = totalAssets - totalLiabilities;

  const current    = history[history.length - 1];
  const maxNet     = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  const hasHistory = history.length > 0;

  const assetTypes     = groupByType(assets);
  const liabilityTypes = groupByType(liabilities);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  const AMT_W  = 14;
  const NAME_W = Math.max(14, inner - AMT_W - 16);

  const pageStart = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE));
  const visible   = rows.slice(pageStart, pageStart + PAGE);
  const labelW    = range === 'year' ? 4 : range === 'quarter' ? 7 : range === 'month' ? 8 : 12;

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
        {showHints && <Text dimColor>[Tab] {view === 'accounts' ? 'by type' : 'by account'}  ·  [r] range  ·  ↑↓ scroll</Text>}
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

          {/* History */}
          {hasHistory && (
            <>
              <Box marginTop={1}><Divider /></Box>
              <Box justifyContent="space-between">
                <Text bold>History</Text>
                <Box gap={2}>
                  {NW_RANGES.map((r) => (
                    <Text key={r} color={r === range ? 'cyan' : undefined} dimColor={r !== range} bold={r === range}>
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
                    <Box key={row.date} gap={2}>
                      <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>
                        {row.label.padEnd(labelW)}
                      </Text>
                      <Text color={row.net >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor={!isSelected}>
                        {fmtSigned(row.net).padStart(14)}
                      </Text>
                      <Text color={row.net >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor>
                        {bar(row.net, maxNet, BAR_WIDTH)}
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
