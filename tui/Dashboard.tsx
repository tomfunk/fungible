import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getRangeSummary, getFlexSummary, getUncategorizedCount, getDataBounds, getAccountRows, type MonthlySummary, type FlexSummary, type AccountRow } from '../core/queries.js';
import { db } from '../core/db.js';
import {
  getPeriodStart, getPeriodDates, navigatePeriod, formatPeriodLabel,
  RANGES, RANGE_LABELS, type Range,
} from '../core/dateUtils.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, bar, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth } from './useTerminalWidth.js';

const BAR_WIDTH = 20;

type DashView = 'categories' | 'flex' | 'account';

function pct(part: number, total: number) {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function getFilteredRangeSummary(from: string, to: string, accountId: string): MonthlySummary {
  const row = db.prepare(`
    SELECT
      COALESCE(-SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as expenses
    FROM transactions
    WHERE date >= ? AND date <= ? AND account_id = ?
      AND pending = 0 AND ignored = 0
      AND category NOT IN (SELECT category FROM hidden_categories)
  `).get(from, to, accountId) as { income: number; expenses: number };

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM transactions
    WHERE date >= ? AND date <= ? AND account_id = ?
      AND amount > 0 AND pending = 0 AND ignored = 0
      AND category NOT IN (SELECT category FROM hidden_categories)
    GROUP BY category ORDER BY total DESC
  `).all(from, to, accountId) as { category: string; total: number }[];

  return { income: row.income, expenses: row.expenses, net: row.income - row.expenses, byCategory };
}

function getFilteredFlexSummary(from: string, to: string, accountId: string): FlexSummary {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN c.flexibility = 'fixed'         AND t.amount > 0 THEN t.amount ELSE 0 END), 0) as fixed,
      COALESCE(SUM(CASE WHEN c.flexibility = 'flexible'      AND t.amount > 0 THEN t.amount ELSE 0 END), 0) as flexible,
      COALESCE(SUM(CASE WHEN c.flexibility = 'discretionary' AND t.amount > 0 THEN t.amount ELSE 0 END), 0) as discretionary,
      COALESCE(SUM(CASE WHEN c.flexibility IS NULL           AND t.amount > 0 THEN t.amount ELSE 0 END), 0) as untagged
    FROM transactions t
    LEFT JOIN categories c ON c.name = t.category
    WHERE t.date >= ? AND t.date <= ? AND t.account_id = ?
      AND t.pending = 0 AND t.ignored = 0
      AND t.category NOT IN (SELECT category FROM hidden_categories)
  `).get(from, to, accountId) as FlexSummary;
}

const FLEX_TIERS: Array<{ key: keyof FlexSummary; label: string; color: string }> = [
  { key: 'fixed',         label: 'Fixed',        color: 'red'    },
  { key: 'flexible',      label: 'Flexible',      color: 'yellow' },
  { key: 'discretionary', label: 'Discretionary', color: 'cyan'   },
  { key: 'untagged',      label: 'Untagged',      color: 'white'  },
];

export function Dashboard({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, filter?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  const now = new Date();
  const [range, setRange] = useState<Range>('month');
  const [anchor, setAnchor] = useState<Date>(() => getPeriodStart('month', now));
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [flexData, setFlexData] = useState<FlexSummary | null>(null);
  const [uncategorized, setUncategorized] = useState(0);
  const [catCursor, setCatCursor] = useState(0);
  const [view, setView] = useState<DashView>('categories');
  const [bounds] = useState(getDataBounds);

  // Account filter
  const [accountRows, setAccountRows] = useState<AccountRow[]>(() => {
    const { from, to } = getPeriodDates('month', getPeriodStart('month', now));
    return getAccountRows(from, to);
  });
  const [acctCursor, setAcctCursor] = useState(0);
  const [selectedAccount, setSelectedAccount] = useState<AccountRow | null>(null);

  function load(r: Range, a: Date, acct: AccountRow | null) {
    const { from, to } = getPeriodDates(r, a);
    setAccountRows(getAccountRows(from, to));
    setAcctCursor(0);
    if (acct) {
      setSummary(getFilteredRangeSummary(from, to, acct.id));
      setFlexData(getFilteredFlexSummary(from, to, acct.id));
      setUncategorized(getUncategorizedCount(from, to, acct.id));
    } else {
      setSummary(getRangeSummary(from, to));
      setFlexData(getFlexSummary(from, to));
      setUncategorized(getUncategorizedCount(from, to));
    }
  }

  useEffect(() => {
    load(range, anchor, selectedAccount);
    setCatCursor(0);
  }, [range, anchor.toISOString().slice(0, 10), selectedAccount?.id ?? null]);

  const categories = summary?.byCategory ?? [];

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // Categories view: [sel+name] gap [amount=10] gap [bar] — 2 gaps of 2
  // reserve: 2 + 10 + 4 = 16; remaining split ~40% name, ~60% bar
  const catFlex = Math.max(20, inner - 16);
  const dashCatNameW = Math.max(12, Math.floor(catFlex * 0.38));
  const dashBarW     = Math.max(8,  catFlex - dashCatNameW);
  // Flex view: [sel+label=18] gap [amount=10] gap [pct=4] gap [bar] — 3 gaps
  const dashFlexBarW = Math.max(8, inner - 38);
  // Account view: [sel=2] gap [name] gap [income=10] gap [expenses=10] — 3 gaps
  const dashAcctNameW = Math.max(12, inner - 28);

  useInput((input, key) => {
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
      if (key.upArrow)   { setCatCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCatCursor((c) => Math.min(categories.length - 1, c + 1)); return; }
      if (key.return) {
        const cat = categories[catCursor];
        if (cat) {
          const { from, to } = getPeriodDates(range, anchor);
          onNavigate('transactions', { category: cat.category, from, to, ...(selectedAccount ? { account: selectedAccount.id, accountName: selectedAccount.name } : {}) });
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

    handleNavKey(input, 'dashboard', onNavigate);
  }, { isActive: isActive !== false });

  const maxCategorySpend = categories[0]?.total ?? 1;
  const totalExpenses = summary?.expenses ?? 0;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="dashboard" showHints={showHints} />
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Text bold>Dashboard</Text>
        {showHints && <Text dimColor>
          {view === 'account'
            ? `← → period  ·  ↑↓ select  ·  Enter txns  ·  Space ${selectedAccount ? 'unfilter' : 'filter'}  ·  [c] clear  ·  [Tab] view`
            : view === 'categories'
            ? '← → period  ·  ↑↓ select  ·  Enter txns  ·  [Tab] view'
            : '← → period  ·  Enter txns  ·  [Tab] view'}
        </Text>}
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          {RANGES.map((r) => (
            <Text key={r} color={r === range ? 'cyan' : undefined} dimColor={r !== range} bold={r === range}>
              {RANGE_LABELS[r]}
            </Text>
          ))}
          {showHints && <Text dimColor>[r]</Text>}
        </Box>
        <Box gap={2}>
          <Text bold>{formatPeriodLabel(range, anchor)}</Text>
          {selectedAccount && <Text color="yellow">{selectedAccount.name}</Text>}
          <Text dimColor>
            {view === 'categories' ? 'categories' : view === 'flex' ? 'flex' : 'account'}{showHints ? '  [Tab]' : ''}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}><Divider /></Box>

      {view === 'account' ? (
        <Box flexDirection="column" marginTop={1}>
          {accountRows.length === 0 ? (
            <Text dimColor>No accounts linked. [8] accounts → link a bank.</Text>
          ) : (
            <>
              <Box gap={2} marginBottom={0}>
                <Text dimColor>{''.padEnd(2)}</Text>
                <Text dimColor>{'Account'.padEnd(dashAcctNameW)}</Text>
                <Text dimColor>{'Income'.padStart(10)}</Text>
                <Text dimColor>{'Expenses'.padStart(10)}</Text>
              </Box>
              {accountRows.map((acct, i) => {
                const isSelected = i === acctCursor;
                const isFiltered = selectedAccount?.id === acct.id;
                return (
                  <Box key={acct.id} gap={2}>
                    <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
                    <Text color={isFiltered ? 'yellow' : isSelected ? 'cyan' : undefined} dimColor={!isSelected && !isFiltered}>
                      {(acct.name.length > dashAcctNameW ? acct.name.slice(0, dashAcctNameW - 1) + '…' : acct.name).padEnd(dashAcctNameW)}
                    </Text>
                    <Text color="green" dimColor={acct.income === 0}>{(acct.income > 0 ? fmt(acct.income) : '—').padStart(10)}</Text>
                    <Text color="red" dimColor={acct.spending === 0}>{(acct.spending > 0 ? fmt(acct.spending) : '—').padStart(10)}</Text>
                    {isFiltered && <Text color="yellow">  ●</Text>}
                  </Box>
                );
              })}
            </>
          )}
          {selectedAccount && (
            <Box marginTop={1}><Text dimColor>[c] clear filter</Text></Box>
          )}
        </Box>
      ) : summary ? (
        <>
          <Box gap={6} marginY={1}>
            <Box flexDirection="column">
              <Text dimColor>Income</Text>
              <Text color="green" bold>{fmt(summary.income)}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>Expenses</Text>
              <Text color="red" bold>{fmt(summary.expenses)}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>Net</Text>
              <Text color={summary.net >= 0 ? 'green' : 'red'} bold>
                {summary.net >= 0 ? '+' : '-'}{fmt(summary.net)}
              </Text>
            </Box>
            {uncategorized > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Uncategorized</Text>
                <Text color="yellow" bold>{uncategorized} txns</Text>
              </Box>
            )}
          </Box>

          <Divider />

          {view === 'categories' ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>SPENDING BY CATEGORY</Text>
              <Box flexDirection="column" marginTop={1}>
                {categories.length === 0 ? (
                  <Text dimColor>No expense data for this period.</Text>
                ) : (
                  categories.map((row, i) => {
                    const isSelected = catCursor === i;
                    return (
                      <Box key={`${row.category}-${i}`} gap={2}>
                        <Text color={isSelected ? 'cyan' : undefined}>
                          {isSelected ? '▶ ' : '  '}
                          {row.category.length > dashCatNameW ? row.category.slice(0, dashCatNameW - 1) + '…' : row.category.padEnd(dashCatNameW)}
                        </Text>
                        <Text color="yellow">{fmt(row.total).padStart(10)}</Text>
                        <Text color="cyan" dimColor={!isSelected}>
                          {bar(row.total, maxCategorySpend, dashBarW)}
                        </Text>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text bold dimColor>SPENDING BY FLEXIBILITY</Text>
              <Box flexDirection="column" marginTop={1}>
                {flexData && FLEX_TIERS.map(({ key, label, color }) => {
                  const amount = flexData[key];
                  if (amount === 0) return null;
                  return (
                    <Box key={key} gap={2}>
                      <Text color={color}>{'  '}{label.padEnd(16)}</Text>
                      <Text color="yellow">{fmt(amount).padStart(10)}</Text>
                      <Text dimColor>{pct(amount, totalExpenses).padStart(4)}</Text>
                      <Text color={color}>{bar(amount, totalExpenses, dashFlexBarW)}</Text>
                    </Box>
                  );
                })}
              </Box>
              {flexData && flexData.untagged > 0 && (
                <Box marginTop={1}><Text dimColor>{pct(flexData.untagged, totalExpenses)} untagged — set tiers in Rules → Categories</Text></Box>
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
