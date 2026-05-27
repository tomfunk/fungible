import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { type TrendsRange } from '../core/dateUtils.js';
import { buildTrendViews, generateAllPeriods, getPeriodTotals, type View, type PeriodRow } from '../core/trends.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, fmtSigned, bar, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth, FLEX_COLORS, C_POSITIVE, C_NEGATIVE, C_NEUTRAL } from './ui.js';

const TRENDS_RANGES: TrendsRange[] = ['week', 'month', 'quarter', 'year'];
const RANGE_LABELS: Record<TrendsRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

function viewColor(view: View): string {
  if (view.mode === 'net')           return 'cyan';
  if (view.mode === 'income')        return C_POSITIVE;
  if (view.mode === 'flexbreakdown') return C_NEUTRAL;
  if (view.mode === 'flex' && view.flex) return FLEX_COLORS[view.flex];
  return C_NEGATIVE;
}

export function Trends({
  onNavigate,
  initialFilter,
  isActive,
  showHints,
}: {
  onNavigate: (s: Screen, f?: TxFilter) => void;
  initialFilter?: TxFilter;
  isActive?: boolean;
  showHints: boolean;
}) {
  const [views] = useState<View[]>(buildTrendViews);
  const [viewIdx, setViewIdx] = useState(() => {
    const cat = initialFilter?.category ?? null;
    if (!cat) return 0;
    const idx = views.findIndex((v) => v.category === cat);
    return idx >= 0 ? idx : 0;
  });
  const [range, setRange] = useState<TrendsRange>('month');
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [cursor, setCursor] = useState(0);

  const view = views[viewIdx] ?? views[0];
  const isNet = view.mode === 'net';
  const isFlexBreakdown = view.mode === 'flexbreakdown';

  useEffect(() => {
    const data = getPeriodTotals(view, range);
    setRows(data);
    setCursor(Math.max(0, data.length - 1));
  }, [viewIdx, range]);

  useInput((input, key) => {
    if (key.escape) { onNavigate('dashboard'); return; }
    if (input === '2') {
      const row = rows[cursor];
      onNavigate('transactions', {
        ...(row ? { from: row.from, to: row.to } : {}),
        ...(view.category ? { category: view.category } : {}),
      });
      return;
    }
    if (handleNavKey(input, 'trends', onNavigate)) return;
    if (key.tab)        { setViewIdx((i) => (i + 1) % views.length); return; }
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (input === 'r') {
      setRange((r) => TRENDS_RANGES[(TRENDS_RANGES.indexOf(r) + 1) % TRENDS_RANGES.length]);
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row) onNavigate('transactions', { category: view.category ?? undefined, from: row.from, to: row.to });
    }
  }, { isActive: isActive !== false });

  const PAGE = 30;
  const pageStart = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE));
  const visible = rows.slice(pageStart, pageStart + PAGE);

  // Scale maxes
  const maxIncome   = isNet ? Math.max(...rows.map((r) => r.income   ?? 0), 1) : 1;
  const maxExpenses = isNet ? Math.max(...rows.map((r) => r.expenses ?? 0), 1) : 1;
  const netMax = Math.max(maxIncome, maxExpenses);

  const flexMax = isFlexBreakdown
    ? Math.max(...rows.flatMap((r) => [r.fixed ?? 0, r.flexible ?? 0, r.discretionary ?? 0]), 1)
    : 1;

  const absMax = isNet          ? netMax
               : isFlexBreakdown ? flexMax
               : Math.max(...rows.map((r) => Math.abs(r.total)), 1);

  const avg  = rows.length ? rows.reduce((s, r) => s + r.total, 0) / rows.length : 0;
  const peak = rows.reduce((best, r) => Math.abs(r.total) > Math.abs(best?.total ?? 0) ? r : best, rows[0]);

  const labelWidth = range === 'week' ? 22 : range === 'month' ? 10 : range === 'quarter' ? 8 : 6;
  const color = viewColor(view);
  const posLabel = `${viewIdx + 1} / ${views.length}`;

  const termW = useTerminalWidth();
  const inner = Math.max(70, termW) - 4;
  const rowBase = 2 + labelWidth; // selector + label
  // Regular: [rowBase] gap [total=13] gap [bar] — 2 gaps of 2
  const BAR_WIDTH = Math.max(8, inner - rowBase - 13 - 4);
  // Net: [rowBase] gap [net=13] gap [leftBar] gap [|=1] gap [rightBar] — 4 gaps of 1, |=1
  const HALF_BAR = Math.max(6, Math.floor((inner - rowBase - 13 - 4 - 1) / 2));
  // Flex: [rowBase] gap [total=13] gap [bar1] gap [bar2] gap [bar3] — 4 gaps of 2
  const FLEX_BAR = Math.max(5, Math.floor((inner - rowBase - 13 - 8) / 3));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="trends" showHints={showHints} />
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Text bold>Trends</Text>
        {showHints && <Text dimColor>[Tab] view  ·  ↑↓ navigate  ·  [r] range  ·  Enter drill in</Text>}
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          {TRENDS_RANGES.map((r) => (
            <Text key={r} color={r === range ? 'cyan' : undefined} dimColor={r !== range} bold={r === range}>
              {RANGE_LABELS[r]}
            </Text>
          ))}
          {showHints && <Text dimColor>[r]</Text>}
        </Box>
        <Text><Text bold>{view.label}</Text><Text dimColor>  {posLabel}</Text></Text>
      </Box>
      <Divider />

      {rows.length === 0 ? (
        <Box marginTop={1}><Text dimColor>No data.</Text></Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {isNet && (
              <Box gap={1} marginBottom={1}>
                <Text dimColor>{' '.repeat(2 + labelWidth)}</Text>
                <Text dimColor>{''.padStart(13)}</Text>
                <Text color={C_NEGATIVE} dimColor>{'expenses ←'.padStart(HALF_BAR)}</Text>
                <Text dimColor>{'|'}</Text>
                <Text color={C_POSITIVE}>{'→ income'}</Text>
              </Box>
            )}
            {isFlexBreakdown && (
              <Box gap={2} marginBottom={1}>
                <Text dimColor>{' '.repeat(2 + labelWidth)}</Text>
                <Text dimColor>{''.padStart(13)}</Text>
                <Text color={FLEX_COLORS.fixed} dimColor>{'fixed'.padEnd(FLEX_BAR)}</Text>
                <Text color={FLEX_COLORS.flexible} dimColor>{'flexible'.padEnd(FLEX_BAR)}</Text>
                <Text color="cyan"   dimColor>{'discr'}</Text>
              </Box>
            )}
            {visible.map((row, i) => {
              const isSelected = rows[pageStart + i] === rows[cursor];

              if (isNet && row.income !== undefined && row.expenses !== undefined) {
                const expFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.expenses / netMax) * HALF_BAR)));
                const incFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.income  / netMax) * HALF_BAR)));
                const leftBar  = '░'.repeat(HALF_BAR - expFilled) + '█'.repeat(expFilled);
                const rightBar = '█'.repeat(incFilled) + '░'.repeat(HALF_BAR - incFilled);
                const net = row.income - row.expenses;
                return (
                  <Box key={row.from} gap={1}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                    </Text>
                    <Text color={net >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor={!isSelected}>
                      {fmtSigned(net).padStart(13)}
                    </Text>
                    <Text color={C_NEGATIVE} dimColor={!isSelected}>{leftBar}</Text>
                    <Text dimColor>|</Text>
                    <Text color={C_POSITIVE} dimColor={!isSelected}>{rightBar}</Text>
                  </Box>
                );
              }

              if (isFlexBreakdown) {
                const fixedF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.fixed ?? 0) / flexMax) * FLEX_BAR)));
                const flexF  = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.flexible ?? 0) / flexMax) * FLEX_BAR)));
                const discrF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.discretionary ?? 0) / flexMax) * FLEX_BAR)));
                return (
                  <Box key={row.from} gap={2}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                    </Text>
                    <Text color={isSelected ? 'white' : undefined} dimColor={!isSelected}>
                      {fmt(row.total).padStart(13)}
                    </Text>
                    <Text color={FLEX_COLORS.fixed} dimColor={!isSelected}>{'█'.repeat(fixedF) + '░'.repeat(FLEX_BAR - fixedF)}</Text>
                    <Text color="yellow" dimColor={!isSelected}>{'█'.repeat(flexF)  + '░'.repeat(FLEX_BAR - flexF)}</Text>
                    <Text color="cyan"   dimColor={!isSelected}>{'█'.repeat(discrF) + '░'.repeat(FLEX_BAR - discrF)}</Text>
                  </Box>
                );
              }

              return (
                <Box key={row.from} gap={2}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                  </Text>
                  <Text color={isSelected ? 'white' : undefined} dimColor={!isSelected}>
                    {fmt(row.total).padStart(13)}
                  </Text>
                  <Text color={color} dimColor={!isSelected}>
                    {bar(row.total, absMax, BAR_WIDTH)}
                  </Text>
                </Box>
              );
            })}
          </Box>

          <Box marginTop={1}><Divider /></Box>
          <Box gap={6} marginTop={1}>
            <Box flexDirection="column">
              <Text dimColor>periods</Text>
              <Text bold>{rows.length}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>avg/{RANGE_LABELS[range].toLowerCase()}</Text>
              <Text bold color={isNet ? (avg >= 0 ? C_POSITIVE : C_NEGATIVE) : undefined}>
                {isNet ? fmtSigned(avg) : fmt(avg)}
              </Text>
            </Box>
            {peak && peak.total > 0 && (
              <Box flexDirection="column">
                <Text dimColor>peak</Text>
                <Text bold>
                  {peak.label}{' '}
                  <Text dimColor>{isNet ? fmtSigned(peak.total) : fmt(peak.total)}</Text>
                </Text>
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
