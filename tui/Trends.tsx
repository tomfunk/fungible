import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { type TrendsRange } from '../core/dateUtils.js';
import { buildTrendViews, generateAllPeriods, getPeriodTotals, getSearchMatchingPeriods, getSearchPeriodTotals, type View, type PeriodRow } from '../core/trends.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, fmtSigned, bar, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, FLEX_COLORS, C_POSITIVE, C_NEGATIVE, C_NEUTRAL, C_ACCENT } from './ui.js';
import { StatCard, usePagination, SelectableRow, PageHeader, TextInput } from './components/index.js';
import { useRefreshKey } from './RefreshContext.js';
import { useSetTyping } from './TypingContext.js';

const TRENDS_RANGES: TrendsRange[] = ['week', 'month', 'quarter', 'year'];
const RANGE_LABELS: Record<TrendsRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

function viewColor(view: View): string {
  if (view.mode === 'net')           return C_ACCENT;
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
  const refreshKey = useRefreshKey();
  const [views, setViews] = useState<View[]>([
    { mode: 'expenses',      category: null, flex: null,            label: 'Expenses'      },
    { mode: 'income',        category: null, flex: null,            label: 'Income'        },
    { mode: 'net',           category: null, flex: null,            label: 'Net'           },
    { mode: 'flexbreakdown', category: null, flex: null,            label: 'Flexibility'   },
    { mode: 'flex',          category: null, flex: 'fixed',         label: 'Fixed'         },
    { mode: 'flex',          category: null, flex: 'flexible',      label: 'Flexible'      },
    { mode: 'flex',          category: null, flex: 'discretionary', label: 'Discretionary' },
  ]);
  const [viewIdx, setViewIdx] = useState(0);
  const [range, setRange] = useState<TrendsRange>(() => {
    const r = initialFilter?.range;
    return (r && (TRENDS_RANGES as string[]).includes(r)) ? r as TrendsRange : 'month';
  });
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [searchRows, setSearchRows] = useState<PeriodRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState(initialFilter?.search ?? '');
  const [searchInput, setSearchInput] = useState(initialFilter?.search ?? '');
  const [searchMode, setSearchMode] = useState(false);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const setTyping = useSetTyping();
  useEffect(() => { setTyping(searchMode); }, [searchMode, setTyping]);

  useEffect(() => {
    void buildTrendViews().then((loaded) => {
      setViews(loaded);
      const cat = initialFilter?.category;
      if (cat) {
        const idx = loaded.findIndex((v) => v.category === cat);
        if (idx >= 0) setViewIdx(idx);
      }
    });
  }, []);

  const view = views[viewIdx] ?? views[0];
  const isNet = view?.mode === 'net';
  const isFlexBreakdown = view?.mode === 'flexbreakdown';

  useEffect(() => {
    if (!view) return;
    void getPeriodTotals(view, range).then((data) => {
      setRows(data);
      setCursor(Math.max(0, data.length - 1));
    });
  }, [viewIdx, range, views, refreshKey]);

  // Live match count while typing; committed search rows
  const liveSearch = searchMode ? searchInput : search;
  useEffect(() => {
    if (!liveSearch) { setMatchCount(null); return; }
    void getSearchMatchingPeriods(liveSearch, range).then(({ count }) => setMatchCount(count));
  }, [liveSearch, range]);

  useEffect(() => {
    if (!search) { setSearchRows([]); return; }
    void getSearchPeriodTotals(search, range).then((data) => {
      setSearchRows(data);
      setCursor(Math.max(0, data.length - 1));
    });
  }, [search, range]);

  const activeRows = search ? searchRows : rows;
  const clampedCursor = activeRows.length > 0 ? Math.min(cursor, activeRows.length - 1) : 0;

  useInput((input, key) => {
    if (searchMode) {
      if (key.escape) { setSearchInput(search); setSearchMode(false); return; }
      if (key.return) { setSearch(searchInput); setSearchMode(false); return; }
      if (key.backspace || key.delete) { setSearchInput((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setSearchInput((s) => s + input); return; }
      return;
    }
    if (input === '/') { setSearchInput(search); setSearchMode(true); return; }
    if (key.escape) {
      if (search) { setSearch(''); setSearchInput(''); return; }
      onNavigate('dashboard');
      return;
    }
    if (input === '1') { onNavigate('dashboard', search ? { search } : undefined); return; }
    if (input === '2') {
      const row = activeRows[clampedCursor];
      onNavigate('transactions', {
        ...(row ? { from: row.from, to: row.to } : {}),
        ...(!search && view.category ? { category: view.category } : {}),
        ...(search ? { search } : {}),
      });
      return;
    }
    if (handleNavKey(input, 'trends', onNavigate)) return;
    if (!search) {
      if (key.leftArrow)  { setViewIdx((i) => (i - 1 + views.length) % views.length); return; }
      if (key.rightArrow) { setViewIdx((i) => (i + 1) % views.length); return; }
    }
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(activeRows.length - 1, c + 1)); return; }
    if (input === 'r') {
      setRange((r) => TRENDS_RANGES[(TRENDS_RANGES.indexOf(r) + 1) % TRENDS_RANGES.length]);
      return;
    }
    if (key.return) {
      const row = activeRows[clampedCursor];
      if (row) onNavigate('transactions', {
        ...(!search && view.category ? { category: view.category } : {}),
        from: row.from, to: row.to,
        ...(search ? { search } : {}),
      });
    }
  }, { isActive: isActive !== false });

  const PAGE = 30;
  const { visible, pageStart } = usePagination(activeRows, clampedCursor, PAGE);

  // Search view: net-style with only matching transaction amounts
  const searchIncome   = search ? searchRows.reduce((s, r) => s + (r.income   ?? 0), 0) : 0;
  const searchExpenses = search ? searchRows.reduce((s, r) => s + (r.expenses ?? 0), 0) : 0;
  const searchHasBoth  = searchIncome > 0 && searchExpenses > 0;
  const searchIncomeOnly = searchIncome > 0 && searchExpenses === 0;

  // Scale maxes
  const maxIncome   = (isNet || search) ? Math.max(...activeRows.map((r) => r.income   ?? 0), 1) : 1;
  const maxExpenses = (isNet || search) ? Math.max(...activeRows.map((r) => r.expenses ?? 0), 1) : 1;
  const netMax = Math.max(maxIncome, maxExpenses);

  const isFlexView = isFlexBreakdown && !search;
  const flexMax = isFlexView
    ? Math.max(...activeRows.flatMap((r) => [r.fixed ?? 0, r.flexible ?? 0, r.discretionary ?? 0]), 1)
    : 1;

  const isNetView = (isNet || search) && !isFlexView;
  const absMax = isNetView        ? netMax
               : isFlexView       ? flexMax
               : Math.max(...activeRows.map((r) => Math.abs(r.total)), 1);

  const avg  = activeRows.length ? activeRows.reduce((s, r) => s + r.total, 0) / activeRows.length : 0;
  const peak = activeRows.reduce((best, r) => Math.abs(r.total) > Math.abs(best?.total ?? 0) ? r : best, activeRows[0]);

  const labelWidth = range === 'week' ? 22 : range === 'month' ? 10 : range === 'quarter' ? 8 : 6;
  const color = viewColor(view);
  const posLabel = `${viewIdx + 1} / ${views.length}`;

  const termW = useTerminalWidth();
  const inner = Math.max(70, termW) - 4;
  const rowBase = 2 + labelWidth;
  const BAR_WIDTH = Math.max(8, inner - rowBase - 13 - 4);
  const HALF_BAR = Math.max(6, Math.floor((inner - rowBase - 13 - 4 - 1) / 2));
  const FLEX_BAR = Math.max(5, Math.floor((inner - rowBase - 13 - 8) / 3));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="trends" showHints={showHints} />

      <Box justifyContent="space-between" marginTop={1}>
        <Text bold>Trends</Text>
        <Text dimColor>{showHints
          ? (searchMode ? '' : search ? '↑↓ navigate  ·  [r] range  ·  [/] search  ·  Enter txns' : '←→ view  ·  ↑↓ navigate  ·  [r] range  ·  [/] search  ·  Enter txns')
          : '[/] search'}
        </Text>
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          {TRENDS_RANGES.map((r) => (
            <Text key={r} color={r === range ? C_ACCENT : undefined} dimColor={r !== range} bold={r === range}>
              {RANGE_LABELS[r]}
            </Text>
          ))}
          {showHints && <Text dimColor>[r]</Text>}
        </Box>
        {!search && (
          <Text><Text dimColor>← </Text><Text bold>{view.label}</Text><Text dimColor> →  {posLabel}</Text></Text>
        )}
      </Box>

      {(searchMode || search) && (
        <Box gap={2} marginTop={1}>
          <Text color={C_ACCENT}>/</Text>
          {searchMode
            ? <TextInput value={searchInput} />
            : <Text color={C_ACCENT}>{search}</Text>}
          {matchCount !== null && (
            <Text dimColor>
              {matchCount} {matchCount === 1 ? 'txn' : 'txns'}
              {!searchMode && searchRows.length > 0 && `  ·  ${searchRows.length} periods`}
            </Text>
          )}
          {!searchMode && search && showHints && <Text dimColor>[ESC] clear  [/] edit</Text>}
          {searchMode && showHints && <Text dimColor>[Enter] apply  [ESC] cancel</Text>}
        </Box>
      )}
      <Divider />

      {activeRows.length === 0 ? (
        <Box marginTop={1}><Text dimColor>{rows.length === 0 ? 'No data.' : 'No periods match the search.'}</Text></Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {(isNetView && (isNet || searchHasBoth || (!searchIncomeOnly && search))) && (
              <Box marginBottom={1}>
                <Text>{'  '}</Text>
                <Box gap={1}>
                  <Text dimColor>{''.padEnd(labelWidth)}</Text>
                  <Text dimColor>{''.padStart(13)}</Text>
                  <Text color={C_NEGATIVE} dimColor>{'expenses ←'.padStart(HALF_BAR)}</Text>
                  <Text dimColor>{'|'}</Text>
                  <Text color={C_POSITIVE}>{'→ income'}</Text>
                </Box>
              </Box>
            )}
            {isFlexView && (
              <Box marginBottom={1}>
                <Text>{'  '}</Text>
                <Box gap={2}>
                  <Text dimColor>{''.padEnd(labelWidth)}</Text>
                  <Text dimColor>{''.padStart(13)}</Text>
                  <Text color={FLEX_COLORS.fixed} dimColor>{'fixed'.padEnd(FLEX_BAR)}</Text>
                  <Text color={FLEX_COLORS.flexible} dimColor>{'flexible'.padEnd(FLEX_BAR)}</Text>
                  <Text color={FLEX_COLORS.discretionary} dimColor>{'discr'}</Text>
                </Box>
              </Box>
            )}
            {visible.map((row, i) => {
              const isSelected = activeRows[pageStart + i] === activeRows[clampedCursor];

              // Net view or search view with both sides
              if (isNetView && row.income !== undefined && row.expenses !== undefined && (isNet || searchHasBoth || (!searchIncomeOnly && search))) {
                const expFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.expenses / netMax) * HALF_BAR)));
                const incFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.income  / netMax) * HALF_BAR)));
                const leftBar  = '░'.repeat(HALF_BAR - expFilled) + '█'.repeat(expFilled);
                const rightBar = '█'.repeat(incFilled) + '░'.repeat(HALF_BAR - incFilled);
                const net = row.income - row.expenses;
                return (
                  <SelectableRow key={row.from} selected={isSelected} gap={1}>
                    <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(labelWidth)}</Text>
                    <Text color={net >= 0 ? C_POSITIVE : C_NEGATIVE} dimColor={!isSelected}>
                      {fmtSigned(net).padStart(13)}
                    </Text>
                    <Text color={C_NEGATIVE} dimColor={!isSelected}>{leftBar}</Text>
                    <Text dimColor>|</Text>
                    <Text color={C_POSITIVE} dimColor={!isSelected}>{rightBar}</Text>
                  </SelectableRow>
                );
              }

              // Search view — income only or expenses only
              if (search && !isFlexView) {
                const searchColor = searchIncomeOnly ? C_POSITIVE : C_NEGATIVE;
                return (
                  <SelectableRow key={row.from} selected={isSelected}>
                    <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(labelWidth)}</Text>
                    <Text color={isSelected ? C_NEUTRAL : undefined} dimColor={!isSelected}>
                      {fmt(Math.abs(row.total)).padStart(13)}
                    </Text>
                    <Text color={searchColor} dimColor={!isSelected}>
                      {bar(Math.abs(row.total), absMax, BAR_WIDTH)}
                    </Text>
                  </SelectableRow>
                );
              }

              if (isFlexView) {
                const fixedF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.fixed ?? 0) / flexMax) * FLEX_BAR)));
                const flexF  = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.flexible ?? 0) / flexMax) * FLEX_BAR)));
                const discrF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.discretionary ?? 0) / flexMax) * FLEX_BAR)));
                return (
                  <SelectableRow key={row.from} selected={isSelected}>
                    <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(labelWidth)}</Text>
                    <Text color={isSelected ? C_NEUTRAL : undefined} dimColor={!isSelected}>
                      {fmt(row.total).padStart(13)}
                    </Text>
                    <Text color={FLEX_COLORS.fixed} dimColor={!isSelected}>{'█'.repeat(fixedF) + '░'.repeat(FLEX_BAR - fixedF)}</Text>
                    <Text color={FLEX_COLORS.flexible} dimColor={!isSelected}>{'█'.repeat(flexF)  + '░'.repeat(FLEX_BAR - flexF)}</Text>
                    <Text color={FLEX_COLORS.discretionary} dimColor={!isSelected}>{'█'.repeat(discrF) + '░'.repeat(FLEX_BAR - discrF)}</Text>
                  </SelectableRow>
                );
              }

              return (
                <SelectableRow key={row.from} selected={isSelected}>
                  <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(labelWidth)}</Text>
                  <Text color={isSelected ? C_NEUTRAL : undefined} dimColor={!isSelected}>
                    {fmt(row.total).padStart(13)}
                  </Text>
                  <Text color={color} dimColor={!isSelected}>
                    {bar(row.total, absMax, BAR_WIDTH)}
                  </Text>
                </SelectableRow>
              );
            })}
          </Box>

          <Box marginTop={1}><Divider /></Box>
          <Box gap={6} marginTop={1}>
            <StatCard label="periods" value={String(activeRows.length)} />
            <StatCard
              label={`avg/${RANGE_LABELS[range].toLowerCase()}`}
              value={isNetView ? fmtSigned(avg) : fmt(avg)}
              color={isNetView ? (avg >= 0 ? C_POSITIVE : C_NEGATIVE) : undefined}
            />
            {peak && peak.total > 0 && (
              <StatCard
                label="peak"
                value={<>{peak.label}{' '}<Text dimColor>{isNetView ? fmtSigned(peak.total) : fmt(peak.total)}</Text></>}
              />
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
