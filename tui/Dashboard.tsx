import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  getRangeSummary, getFlexSummary, getUncategorizedCount, getDataBounds, getAccountRows,
  getCategoryDriftData, getFlexDriftData, getAccountDriftData, countSearchMatches, getSearchFilteredData, getMerchantSummary,
  type MonthlySummary, type FlexSummary, type AccountRow,
  type CategoryDrift, type FlexDriftData, type AccountDrift, type MerchantSummaryRow,
} from '../core/queries.js';
import {
  getPeriodStart, getPeriodDates, navigatePeriod, formatPeriodLabel,
  getDriftWindows,
  RANGES, RANGE_LABELS, type Range,
} from '../core/dateUtils.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, fmtSigned, bar, Divider, truncate } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, FLEX_COLORS, C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_MANUAL, C_ACCENT } from './ui.js';
import { StatCard, SectionHeader, SelectableRow, TextInput, PageHeader } from './components/index.js';
import { useSetTyping } from './TypingContext.js';
import { useRefreshKey } from './RefreshContext.js';

const BAR_WIDTH = 20;

type DashView = 'categories' | 'flex' | 'account';

function pct(part: number, total: number) {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

/** Heat-map color based on current spend vs 12-month rolling average. */
function driftColor(current: number, avg12m: number): string {
  if (current === 0) return C_NEUTRAL;
  if (avg12m === 0) return C_NEGATIVE;     // new spending with no history
  const ratio = current / avg12m;
  if (ratio <= 1.10) return C_POSITIVE;   // within 10% of average
  if (ratio <= 1.30) return C_WARNING;    // creeping (10–30% over)
  return C_NEGATIVE;                      // spiked (>30% over)
}

/** Format a drift delta value compactly (no cents). */
function fmtDelta(delta: number): string {
  if (delta === 0) return '—';
  return fmtSigned(delta, 0);
}


const FLEX_TIERS: Array<{ key: keyof FlexSummary; label: string; color: string }> = [
  { key: 'fixed',         label: 'Fixed',        color: FLEX_COLORS.fixed         },
  { key: 'flexible',      label: 'Flexible',      color: FLEX_COLORS.flexible      },
  { key: 'discretionary', label: 'Discretionary', color: FLEX_COLORS.discretionary },
  { key: 'untagged',      label: 'Untagged',      color: C_NEUTRAL                 },
];

export function Dashboard({ onNavigate, isActive, initialFilter, showHints }: { onNavigate: (s: Screen, filter?: TxFilter) => void; isActive?: boolean; initialFilter?: TxFilter; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const now = new Date();
  const [range, setRange] = useState<Range>(() => {
    const r = initialFilter?.range;
    return (r && (RANGES as string[]).includes(r)) ? r as Range : 'month';
  });
  const [anchor, setAnchor] = useState<Date>(() => {
    const r: Range = (initialFilter?.range && (RANGES as string[]).includes(initialFilter.range)) ? initialFilter.range as Range : 'month';
    if (initialFilter?.anchor && /^\d{4}-\d{2}-\d{2}$/.test(initialFilter.anchor)) {
      const [y, m, d] = initialFilter.anchor.split('-').map(Number);
      return getPeriodStart(r, new Date(y, m - 1, d));
    }
    return getPeriodStart(r, now);
  });
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [flexData, setFlexData] = useState<FlexSummary | null>(null);
  const [uncategorized, setUncategorized] = useState(0);
  const [catCursor, setCatCursor] = useState(0);
  const [view, setView] = useState<DashView>('categories');
  const [bounds, setBounds] = useState<{ minDate: string; maxDate: string }>({ minDate: '2000-01-01', maxDate: '2099-12-31' });
  useEffect(() => { void getDataBounds().then(setBounds); }, []);
  const [driftMode, setDriftMode] = useState(false);
  const [catDrift,  setCatDrift]  = useState<CategoryDrift[] | null>(null);
  const [flexDrift, setFlexDrift] = useState<FlexDriftData  | null>(null);
  const [acctDrift, setAcctDrift] = useState<AccountDrift[] | null>(null);
  const [merchantRows, setMerchantRows] = useState<MerchantSummaryRow[]>([]);
  const [merchantCursor, setMerchantCursor] = useState(0);
  const [merchantDrill, setMerchantDrill] = useState<{ category: string; from: string; to: string } | null>(null);

  // Search
  const [search,          setSearch]          = useState(initialFilter?.search ?? '');
  const [searchInput,     setSearchInput]     = useState(initialFilter?.search ?? '');
  const [searchMode,      setSearchMode]      = useState(false);
  const [searchStats,     setSearchStats]     = useState<{ count: number; expenses: number } | null>(null);
  const [filteredSummary, setFilteredSummary] = useState<MonthlySummary | null>(null);
  const [filteredFlex,    setFilteredFlex]    = useState<FlexSummary    | null>(null);

  // Account filter
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [acctCursor, setAcctCursor] = useState(0);
  const [selectedAccount, setSelectedAccount] = useState<AccountRow | null>(null);

  function load(r: Range, a: Date, acct: AccountRow | null) {
    const { from, to } = getPeriodDates(r, a);
    void getAccountRows(from, to).then(setAccountRows);
    setAcctCursor(0);
    if (acct) {
      void getRangeSummary(from, to, acct.id).then(setSummary);
      void getFlexSummary(from, to, acct.id).then(setFlexData);
      void getUncategorizedCount(from, to, acct.id).then(setUncategorized);
    } else {
      void getRangeSummary(from, to).then(setSummary);
      void getFlexSummary(from, to).then(setFlexData);
      void getUncategorizedCount(from, to).then(setUncategorized);
    }
  }

  function openMerchantDrill(category: string, from: string, to: string) {
    setMerchantDrill({ category, from, to });
    setMerchantCursor(0);
    void getMerchantSummary(category, from, to, selectedAccount?.id ?? undefined).then(setMerchantRows);
  }

  useEffect(() => {
    load(range, anchor, selectedAccount);
    setCatCursor(0);
  }, [range, anchor.toISOString().slice(0, 10), selectedAccount?.id ?? null, refreshKey]);

  useEffect(() => {
    if (!driftMode) { setCatDrift(null); setFlexDrift(null); setAcctDrift(null); return; }
    const windows = getDriftWindows(range, anchor, new Date());
    if (!windows) { setCatDrift(null); setFlexDrift(null); setAcctDrift(null); return; }
    const { current, lastPeriod, lastYear, rolling12 } = windows;
    const acctId = selectedAccount?.id ?? undefined;
    void getCategoryDriftData(current, lastPeriod, lastYear, rolling12, acctId).then(setCatDrift);
    void getFlexDriftData(current, lastPeriod, lastYear, rolling12, acctId).then(setFlexDrift);
    void getAccountDriftData(current, lastPeriod, lastYear, rolling12).then(setAcctDrift);
  }, [driftMode, range, anchor.toISOString().slice(0, 10), selectedAccount?.id ?? null]);

  const setTyping = useSetTyping();
  useEffect(() => { setTyping(searchMode); }, [searchMode]);

  useEffect(() => {
    const term = searchMode ? searchInput : search;
    if (!term) { setSearchStats(null); return; }
    const { from, to } = getPeriodDates(range, anchor);
    void countSearchMatches(from, to, term, selectedAccount?.id ?? undefined).then(setSearchStats);
  }, [searchMode ? searchInput : search, range, anchor.toISOString().slice(0, 10), selectedAccount?.id ?? null]);

  // When a search is committed, recompute category + flex data to only show matching transactions
  useEffect(() => {
    if (!search) { setFilteredSummary(null); setFilteredFlex(null); return; }
    const { from, to } = getPeriodDates(range, anchor);
    void getSearchFilteredData(from, to, search, selectedAccount?.id ?? undefined).then(({ summary: fs, flexData: ff }) => {
      setFilteredSummary(fs);
      setFilteredFlex(ff);
    });
  }, [search, range, anchor.toISOString().slice(0, 10), selectedAccount?.id ?? null]);

  // Close drill when filter context changes significantly
  // Note: anchor and range are intentionally excluded — period/range nav keeps drill open
  useEffect(() => {
    setMerchantDrill(null);
    setMerchantRows([]);
    setMerchantCursor(0);
  }, [selectedAccount?.id ?? null, search, driftMode, view]);

  // Re-fetch merchant data when period or range changes while drill is active
  useEffect(() => {
    if (!merchantDrill) return;
    const { from, to } = getPeriodDates(range, anchor);
    const { category } = merchantDrill;
    setMerchantDrill({ category, from, to });
    setMerchantCursor(0);
    void getMerchantSummary(category, from, to, selectedAccount?.id ?? undefined).then(setMerchantRows);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.toISOString().slice(0, 10), range]);

  const categories = summary?.byCategory ?? [];

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // Normal categories: [sel+name] gap [amount=10] gap [bar] — 2 gaps of 2 = 16 reserved
  const catFlex      = Math.max(20, inner - 16);
  const dashCatNameW = Math.max(12, Math.floor(catFlex * 0.38));
  const dashBarW     = Math.max(8,  catFlex - dashCatNameW);
  // Drift categories: 3 delta cols × 9 chars + 4 gaps of 2 = 27+8=35 for cols; plus amount(10)+gaps
  // total fixed = 2(cursor) + 10(amt) + 4(gaps to amt) + 27(3×9) + 4(gaps between deltas) = 47
  const driftCatNameW = Math.max(12, inner - 47);
  // Normal flex: [label=18] gap [amount=10] gap [pct=4] gap [bar] — 3 gaps of 2
  const dashFlexBarW  = Math.max(8, inner - 38);
  // Account: [sel=2] gap [name] gap [col1=10] gap [col2=10] — 3 gaps of 2
  const dashAcctNameW = Math.max(12, inner - 28);
  // Merchants: [sel=2] gap [name] gap [amount=10] gap [count=6] gap [pct=6]
  const merchantNameW = Math.max(12, inner - 30);

  useInput((input, key) => {
    if (merchantDrill) {
      if (key.escape) {
        setMerchantDrill(null);
        setMerchantRows([]);
        setMerchantCursor(0);
        return;
      }
      if (key.upArrow)   { setMerchantCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setMerchantCursor((c) => merchantRows.length > 0 ? Math.min(merchantRows.length - 1, c + 1) : 0); return; }
      if (key.return) {
        const row = merchantRows[merchantCursor];
        if (row && merchantDrill) {
          onNavigate('transactions', {
            category: merchantDrill.category,
            from: merchantDrill.from,
            to: merchantDrill.to,
            search: row.merchant,
            ...(selectedAccount ? { account: selectedAccount.id, accountName: selectedAccount.name } : {}),
          });
        }
        return;
      }
      // ← →, r: fall through — re-fetch effect handles merchant refresh on anchor/range change
      if (!key.leftArrow && !key.rightArrow && input !== 'r') { return; }
    }

    // Search input mode — capture all keys
    if (searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchInput(search); // restore to last committed
        return;
      }
      if (key.return) {
        setSearch(searchInput);
        setSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        const next = searchInput.slice(0, -1);
        setSearchInput(next);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchInput((s) => s + input);
      }
      return;
    }

    if (key.tab) {
      setView((v) => v === 'categories' ? 'flex' : v === 'flex' ? 'account' : 'categories');
      return;
    }

    // Period navigation (all views)
    if (key.leftArrow && range !== 'alltime') {
      const next = navigatePeriod(range, anchor, -1);
      const { from } = getPeriodDates(range, next);
      if (from >= bounds.minDate) setAnchor(next);
      return;
    }
    if (key.rightArrow && range !== 'alltime') {
      const next = navigatePeriod(range, anchor, 1);
      const { from } = getPeriodDates(range, next);
      if (from <= bounds.maxDate) setAnchor(next);
      return;
    }

    if (view === 'categories') {
      const displayCats = displaySummary?.byCategory ?? [];
      if (key.upArrow)   { setCatCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCatCursor((c) => Math.min(displayCats.length - 1, c + 1)); return; }
      if (input === 'm' && !driftMode) {
        const cat = displayCats[catCursor];
        if (cat) {
          const { from, to } = getPeriodDates(range, anchor);
          openMerchantDrill(cat.category, from, to);
        }
        return;
      }
      if (key.return) {
        const cat = displayCats[catCursor];
        if (cat) {
          const { from, to } = getPeriodDates(range, anchor);
          onNavigate('transactions', { category: cat.category, from, to, ...(selectedAccount ? { account: selectedAccount.id, accountName: selectedAccount.name } : {}), ...(search ? { search } : {}) });
        }
        return;
      }
    }

    if (view === 'flex') {
      if (key.return) {
        const { from, to } = getPeriodDates(range, anchor);
        onNavigate('transactions', { from, to, ...(selectedAccount ? { account: selectedAccount.id, accountName: selectedAccount.name } : {}) });
        return;
      }
    }

    if (view === 'account') {
      if (key.upArrow)   { setAcctCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setAcctCursor((c) => Math.min(accountRows.length - 1, c + 1)); return; }
      if (key.return) {
        const acct = accountRows[acctCursor];
        if (acct) {
          const { from, to } = getPeriodDates(range, anchor);
          onNavigate('transactions', { account: acct.id, accountName: acct.name, from, to });
        }
        return;
      }
      if (input === ' ') {
        const acct = accountRows[acctCursor];
        if (acct) {
          setSelectedAccount(selectedAccount?.id === acct.id ? null : acct);
        }
        return;
      }
      if (input === 'c') { setSelectedAccount(null); return; }
    }

    if (input === 'r') {
      const idx = RANGES.indexOf(range);
      const next = RANGES[(idx + 1) % RANGES.length];
      setRange(next);
      setAnchor(getPeriodStart(next, now));
      setCatCursor(0);
      return;
    }

    if (input === 'd') { setDriftMode((m) => !m); return; }

    if (input === '/') {
      setSearchInput(search); // pre-fill with current search
      setSearchMode(true);
      return;
    }

    if (key.escape && search) {
      setSearch('');
      setSearchInput('');
      setSearchStats(null);
      return;
    }

    // Intercept '2' to carry search + period filter into Transactions
    if (input === '2') {
      const { from, to } = getPeriodDates(range, anchor);
      onNavigate('transactions', {
        from, to,
        ...(selectedAccount ? { account: selectedAccount.id, accountName: selectedAccount.name } : {}),
        ...(search ? { search } : {}),
      });
      return;
    }

    handleNavKey(input, 'dashboard', onNavigate);
  }, { isActive: isActive !== false });

  const displaySummary  = filteredSummary ?? summary;
  const displayFlexData = filteredFlex    ?? flexData;
  const maxCategorySpend = (displaySummary?.byCategory[0]?.total ?? categories[0]?.total) ?? 1;
  const totalExpenses = displaySummary?.expenses ?? 0;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="dashboard" showHints={showHints} />

      <Box marginTop={1}><Text bold>Dashboard</Text></Box>
      {merchantDrill
        ? showHints && <Text dimColor>← → period  ·  [r] range  ·  ↑↓ merchant  ·  Enter txns  ·  Esc back</Text>
        : <Text dimColor>
            {showHints
              ? (view === 'account'
                  ? `[/] search  ·  ← → period  ·  ↑↓ select  ·  Enter txns  ·  Space ${selectedAccount ? 'unfilter' : 'filter'}  ·  [c] clear  ·  [Tab] view  ·  [d] delta`
                  : view === 'categories'
                    ? `[/] search  ·  ← → period  ·  ↑↓ select  ·  Enter txns${driftMode ? '' : '  ·  [m] merchants'}  ·  [Tab] view  ·  [d] delta`
                    : '[/] search  ·  ← → period  ·  Enter txns  ·  [Tab] view  ·  [d] delta')
              : '[/] search'}
          </Text>
      }

      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          {RANGES.map((r) => (
            <Text key={r} color={r === range ? C_ACCENT : undefined} dimColor={r !== range} bold={r === range}>
              {RANGE_LABELS[r]}
            </Text>
          ))}
          {showHints && <Text dimColor>[r]</Text>}
        </Box>
        <Box gap={2}>
          <Text bold>{formatPeriodLabel(range, anchor)}</Text>
          {selectedAccount && <Text color={C_WARNING}>{selectedAccount.name}</Text>}
          {driftMode && <Text color={C_MANUAL} bold>delta</Text>}
          <Text dimColor>
            {merchantDrill ? `merchants · ${merchantDrill.category}` : view === 'categories' ? 'categories' : view === 'flex' ? 'flex' : 'account'}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}><Divider /></Box>

      {/* Search bar */}
      {(searchMode || search) && (
        <Box gap={2} marginTop={1}>
          <Text color={C_ACCENT}>/</Text>
          {searchMode ? (
            <TextInput value={searchInput} />
          ) : (
            <Text color={C_ACCENT}>{search}</Text>
          )}
          {searchStats && (
            <Text dimColor>
              {searchStats.count} {searchStats.count === 1 ? 'txn' : 'txns'}
              {searchStats.expenses > 0 ? `  ${fmt(searchStats.expenses)}` : ''}
            </Text>
          )}
          {!searchMode && search && showHints && (
            <Text dimColor>[ESC] clear  [/] edit  [2] view txns</Text>
          )}
          {searchMode && showHints && (
            <Text dimColor>[Enter] apply  [ESC] cancel</Text>
          )}
        </Box>
      )}

      {view === 'account' ? (
        <Box flexDirection="column" marginTop={1}>
          {accountRows.length === 0 ? (
            <Text dimColor>No accounts linked. [8] accounts → link a bank.</Text>
          ) : driftMode && range === 'alltime' ? (
            <Text dimColor>Delta not available for All Time range.</Text>
          ) : (
            <>
              <Box marginBottom={0}>
                <Text dimColor>{'  '}</Text>
                <Box gap={2}>
                  <Text dimColor>{'Account'.padEnd(dashAcctNameW)}</Text>
                  {driftMode
                    ? <Text dimColor>{'vs prev'.padStart(10)}</Text>
                    : <Text dimColor>{'Income'.padStart(10)}</Text>}
                  <Text dimColor>{'Expenses'.padStart(10)}</Text>
                </Box>
              </Box>
              {accountRows.map((acct, i) => {
                const isSelected = i === acctCursor;
                const isFiltered = selectedAccount?.id === acct.id;
                const drift = driftMode ? acctDrift?.find((d) => d.id === acct.id) : undefined;
                const spendColor = drift ? driftColor(drift.current, drift.avg12m) : C_NEGATIVE;
                return (
                  <SelectableRow key={acct.id} selected={isSelected}>
                    <Text color={isFiltered ? C_WARNING : isSelected ? C_ACCENT : undefined} dimColor={!isSelected && !isFiltered}>
                      {(acct.name.length > dashAcctNameW ? acct.name.slice(0, dashAcctNameW - 1) + '…' : acct.name).padEnd(dashAcctNameW)}
                    </Text>
                    {driftMode
                      ? <Text color={drift ? spendColor : C_NEUTRAL} dimColor={!drift}>
                          {drift ? fmtDelta(drift.lastPeriodDelta).padStart(10) : '—'.padStart(10)}
                        </Text>
                      : <Text color={C_POSITIVE} dimColor={acct.income === 0}>{(acct.income > 0 ? fmt(acct.income) : '—').padStart(10)}</Text>}
                    <Text color={driftMode ? spendColor : C_NEGATIVE} dimColor={acct.spending === 0}>
                      {(acct.spending > 0 ? fmt(acct.spending) : '—').padStart(10)}
                    </Text>
                    {isFiltered && <Text color={C_WARNING}>  ●</Text>}
                  </SelectableRow>
                );
              })}
            </>
          )}
          {selectedAccount && (
            <Box marginTop={1}><Text dimColor>[c] clear filter</Text></Box>
          )}
        </Box>
      ) : displaySummary ? (
        <>
          <Box gap={6} marginY={1}>
            <StatCard label="Income" value={fmt(displaySummary.income)} color={C_POSITIVE} />
            <StatCard label="Expenses" value={fmt(displaySummary.expenses)} color={C_NEGATIVE} />
            <StatCard label="Net" value={(displaySummary.net >= 0 ? '+' : '-') + fmt(displaySummary.net)} color={displaySummary.net >= 0 ? C_POSITIVE : C_NEGATIVE} />
            {!search && uncategorized > 0 && (
              <StatCard label="Uncategorized" value={`${uncategorized} txns`} color={C_WARNING} />
            )}
          </Box>

          <Divider />

          {view === 'categories' ? (
            <Box flexDirection="column" marginTop={1}>
              <SectionHeader>{merchantDrill ? `TOP MERCHANTS · ${merchantDrill.category}` : 'SPENDING BY CATEGORY'}</SectionHeader>
              {merchantDrill ? (
                <Box flexDirection="column" marginTop={1}>
                  {merchantRows.length === 0 ? (
                    <Text dimColor>No merchant spend for this category in this period.</Text>
                  ) : (
                    merchantRows.map((row, i) => {
                      const isSelected = merchantCursor === i;
                      return (
                        <SelectableRow key={`${row.merchant}-${i}`} selected={isSelected}>
                          <Text color={isSelected ? C_ACCENT : undefined}>
                            {truncate(row.merchant, merchantNameW).padEnd(merchantNameW)}
                          </Text>
                          <Text color={C_WARNING}>{fmt(row.total).padStart(10)}</Text>
                          <Text dimColor>{`${row.count}x`.padStart(6)}</Text>
                          <Text dimColor>{`${Math.round(row.pct * 100)}%`.padStart(6)}</Text>
                        </SelectableRow>
                      );
                    })
                  )}
                  {showHints && <Box marginTop={1}><Text dimColor>[Enter] transactions  ·  [Esc] back</Text></Box>}
                </Box>
              ) : driftMode && range === 'alltime' ? (
                <Box marginTop={1}><Text dimColor>Delta not available for All Time range.</Text></Box>
              ) : driftMode ? (
                <Box flexDirection="column" marginTop={1}>
                  {/* column headers */}
                  <Box>
                    <Text dimColor>{'  '}</Text>
                    <Box gap={2}>
                      <Text dimColor>{''.padEnd(driftCatNameW)}</Text>
                      <Text dimColor>{'amount'.padStart(10)}</Text>
                      <Text dimColor>{'vs prev'.padStart(9)}</Text>
                      <Text dimColor>{'yr ago'.padStart(9)}</Text>
                      <Text dimColor>{'12m avg'.padStart(9)}</Text>
                    </Box>
                  </Box>
                  {(catDrift ?? []).length === 0 ? (
                    <Text dimColor>No expense data for this period.</Text>
                  ) : (
                    (catDrift ?? []).map((row, i) => {
                      const isSelected = catCursor === i;
                      const color = driftColor(row.current, row.avg12m);
                      const nameW = driftCatNameW;
                      return (
                        <SelectableRow key={`${row.category}-${i}`} selected={isSelected}>
                          <Text color={isSelected ? C_ACCENT : color}>
                            {row.category.length > nameW ? row.category.slice(0, nameW - 1) + '…' : row.category.padEnd(nameW)}
                          </Text>
                          <Text color={C_NEUTRAL}>{fmt(row.current).padStart(10)}</Text>
                          <Text color={color}>{fmtDelta(row.lastPeriodDelta).padStart(9)}</Text>
                          <Text color={color}>{fmtDelta(row.lastYearDelta).padStart(9)}</Text>
                          <Text color={color}>{fmtDelta(row.avg12mDelta).padStart(9)}</Text>
                        </SelectableRow>
                      );
                    })
                  )}
                </Box>
              ) : (
                <Box flexDirection="column" marginTop={1}>
                  {(displaySummary?.byCategory ?? []).length === 0 ? (
                    <Text dimColor>{search ? 'No matching transactions for this period.' : 'No expense data for this period.'}</Text>
                  ) : (
                    (displaySummary?.byCategory ?? []).map((row, i) => {
                      const isSelected = catCursor === i;
                      return (
                        <SelectableRow key={`${row.category}-${i}`} selected={isSelected}>
                          <Text color={isSelected ? C_ACCENT : undefined}>
                            {row.category.length > dashCatNameW ? row.category.slice(0, dashCatNameW - 1) + '…' : row.category.padEnd(dashCatNameW)}
                          </Text>
                          <Text color={C_NEUTRAL}>{fmt(row.total).padStart(10)}</Text>
                          <Text color={C_ACCENT} dimColor={!isSelected}>
                            {bar(row.total, maxCategorySpend, dashBarW)}
                          </Text>
                        </SelectableRow>
                      );
                    })
                  )}
                </Box>
              )}
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <SectionHeader>SPENDING BY FLEXIBILITY</SectionHeader>
              {driftMode && range === 'alltime' ? (
                <Box marginTop={1}><Text dimColor>Delta not available for All Time range.</Text></Box>
              ) : driftMode ? (
                <Box flexDirection="column" marginTop={1}>
                  {/* column headers */}
                  <Box gap={2}>
                    <Text dimColor>{''.padEnd(18)}</Text>
                    <Text dimColor>{'amount'.padStart(10)}</Text>
                    <Text dimColor>{'vs prev'.padStart(9)}</Text>
                    <Text dimColor>{'yr ago'.padStart(9)}</Text>
                    <Text dimColor>{'12m avg'.padStart(9)}</Text>
                  </Box>
                  {flexDrift && FLEX_TIERS.map(({ key, label }) => {
                    const slice = flexDrift[key];
                    if (slice.current === 0 && slice.avg12m === 0) return null;
                    const color = driftColor(slice.current, slice.avg12m);
                    return (
                      <Box key={key} gap={2}>
                        <Text color={color}>{'  '}{label.padEnd(16)}</Text>
                        <Text color={C_NEUTRAL}>{fmt(slice.current).padStart(10)}</Text>
                        <Text color={color}>{fmtDelta(slice.lastPeriodDelta).padStart(9)}</Text>
                        <Text color={color}>{fmtDelta(slice.lastYearDelta).padStart(9)}</Text>
                        <Text color={color}>{fmtDelta(slice.avg12mDelta).padStart(9)}</Text>
                      </Box>
                    );
                  })}
                </Box>
              ) : (
                <Box flexDirection="column" marginTop={1}>
                  {displayFlexData && FLEX_TIERS.map(({ key, label, color }) => {
                    const amount = displayFlexData[key];
                    if (amount === 0) return null;
                    return (
                      <Box key={key} gap={2}>
                        <Text color={color}>{'  '}{label.padEnd(16)}</Text>
                        <Text color={C_NEUTRAL}>{fmt(amount).padStart(10)}</Text>
                        <Text dimColor>{pct(amount, totalExpenses).padStart(4)}</Text>
                        <Text color={color}>{bar(amount, totalExpenses, dashFlexBarW)}</Text>
                      </Box>
                    );
                  })}
                </Box>
              )}
              {!driftMode && displayFlexData && displayFlexData.untagged > 0 && !search && (
                <Box marginTop={1}><Text dimColor>{pct(displayFlexData.untagged, totalExpenses)} untagged — set tiers in Rules → Categories</Text></Box>
              )}
            </Box>
          )}
        </>
      ) : (
        <Text dimColor>Loading...</Text>
      )}
    </Box>
  );
}
