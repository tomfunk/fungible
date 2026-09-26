import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import {
  fmt, fmtSigned, fmtPct, fmtMonths, fmtCompact, Divider,
  bar, periodLabel, periodLabelWidth, HISTORY_RANGES, HISTORY_RANGE_LABELS, type HistoryRange,
} from './fmt.js';
import { handleNavKey } from './nav.js';
import {
  loadHealthData, getHealthHistory, yearsToFire, coastYears, computeSavingsRate,
  computeFireRunwayMetrics, savingsRateSeverity, runwaySeverity, debtPayoffSeverity,
  type HealthData, type HealthHistoryPeriod,
} from '../core/health.js';
import { getSetting, setSetting, PRETAX_MONTHLY_KEY } from '../core/settings.js';
import { BASIS_LABEL } from '../core/dateUtils.js';
import { C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_ACCENT, severityColor } from './ui.js';
import { SectionHeader, PageHeader, DialRow, usePagination } from './components/index.js';
import { useRefreshKey } from './RefreshContext.js';
import { useLoadGuard } from './useLoadGuard.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WITHDRAWAL    = 4.0;
const DEFAULT_GROWTH        = 7.0;
const SPEND_STEP            = 100;
const WITHDRAW_STEP         = 0.5;
const GROWTH_STEP           = 1.0;
const PROGRESS_BAR_WIDTH    = 22;

const DIALS = ['spend', 'savings', 'pretax', 'withdrawal', 'growth'] as const;
type Dial = typeof DIALS[number];

function progressBar(ratio: number, width = PROGRESS_BAR_WIDTH) {
  const filled = Math.min(width, Math.max(0, Math.round(Math.min(1, ratio) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─── History mode ───────────────────────────────────────────────────────────
// Reuses NetWorth.tsx's period-bucketed bar/value list pattern (shared helpers
// live in charUtils.ts / fmt.tsx), but shows one metric at a time -- Health has
// too many chartable metrics to lay out side by side in a terminal, unlike
// NetWorth's single net-worth series. Deliberately excludes cash/liquid/
// totalDebt/netWorth as their own series (that's the Net Worth screen's job);
// retirement balance is charted here anyway since it's already Health's own
// RETIREMENT panel, not a duplicate of Net Worth's asset breakdown.
const HISTORY_PAGE = 20;
const HISTORY_BAR_WIDTH = 24;
// Two-tier History mode: a fixed-metric "at a glance" compact view (first [t]),
// then the full metric/range/pagination drill-down (second [t]) -- see the
// historyTier state in the component for the tier transitions themselves.
const HISTORY_COMPACT_PERIODS = 6;

type HistoryMetricId = 'savingsRate' | 'cashRunway' | 'liquidRunway' | 'debtPayoff' | 'retirement' | 'yearsToFire' | 'coastFire';

// yearsToFire/coastFire depend on the live growth/withdrawal-rate/spend dials,
// which aren't versioned per period -- flagged so the UI can caption that
// today's assumptions are being applied to each period's past balance, not
// that the assumptions themselves are historical.
const HISTORY_METRICS: { id: HistoryMetricId; label: string; needsAssumptionCaption?: boolean }[] = [
  { id: 'savingsRate',  label: 'Savings rate' },
  { id: 'cashRunway',   label: 'Cash runway' },
  { id: 'liquidRunway', label: 'Liquid runway' },
  { id: 'debtPayoff',   label: 'Debt payoff' },
  { id: 'retirement',   label: 'Retirement Balance' },
  { id: 'yearsToFire',  label: 'Years to FIRE', needsAssumptionCaption: true },
  { id: 'coastFire',    label: 'Coast FIRE', needsAssumptionCaption: true },
];

// The compact tier always shows this one metric ("at a glance" -- see the
// coordinator's spec), independent of whatever metricIdx the full tier is
// currently on, so backing in and out of the full tier can't change what the
// compact tier displays.
const COMPACT_METRIC = HISTORY_METRICS[0];

type HistoryPoint = {
  period: string;
  savingsRate: number | null;
  cashRunway: number;
  liquidRunway: number;
  debtPayoff: number | null;
  retirement: number;
  yearsToFire: number | null;
  coastFire: number | null;
};

/**
 * Derives one HistoryPoint per HealthHistoryPeriod row. Runway/debt-payoff/
 * savings-rate use that period's OWN actual spend/income/savings (a fully
 * historical trend); FIRE-number derived values (yearsToFire, coastFire) use
 * the CALLER's live fireNumber/monthlySavings/growth dial state applied to
 * that period's own net worth -- see needsAssumptionCaption above.
 */
function computeHistoryPoint(
  row: HealthHistoryPeriod,
  live: { pretaxSavings: number; fireNumber: number; savingsForFire: number; growth: number },
): HistoryPoint {
  const m = computeFireRunwayMetrics({
    monthlySpend: row.avgMonthlyExpenses,
    withdrawalRatePct: 0, // unused below -- fireNumber/fireProgress aren't read from this call
    cash: row.cash,
    liquid: row.liquid,
    totalDebt: row.totalDebt,
    monthlySavings: row.monthlySavings,
    netWorth: row.netWorth,
  });
  return {
    period: row.period,
    savingsRate: computeSavingsRate(row.monthlyIncome, row.monthlySavings, live.pretaxSavings),
    cashRunway: m.cashRunwayMonths,
    liquidRunway: m.liquidRunwayMonths,
    debtPayoff: m.debtPayoffMonths,
    retirement: row.retirement,
    yearsToFire: yearsToFire(row.netWorth, live.savingsForFire, live.fireNumber, live.growth),
    coastFire: coastYears(row.netWorth, live.fireNumber, live.growth),
  };
}

const HISTORY_VALUE: Record<HistoryMetricId, (p: HistoryPoint) => number | null> = {
  savingsRate:  (p) => p.savingsRate,
  cashRunway:   (p) => p.cashRunway,
  liquidRunway: (p) => p.liquidRunway,
  debtPayoff:   (p) => p.debtPayoff,
  retirement:   (p) => p.retirement,
  yearsToFire:  (p) => p.yearsToFire,
  coastFire:    (p) => p.coastFire,
};

function formatHistoryValue(id: HistoryMetricId, v: number | null): string {
  switch (id) {
    case 'savingsRate':  return v === null ? '—' : fmtPct(v);
    case 'cashRunway':
    case 'liquidRunway': return fmtMonths(v as number);
    case 'debtPayoff':   return v === null ? '—' : fmtMonths(v);
    case 'retirement':   return fmtCompact(v as number);
    case 'yearsToFire':  return v === null ? '100+ yr' : v === 0 ? 'Achieved!' : `~${Math.ceil(v)} yr`;
    case 'coastFire':    return v === null ? '—' : v === 0 ? 'Achieved!' : `~${Math.ceil(v)} yr`;
  }
}

function historyValueColor(id: HistoryMetricId, v: number | null): string | undefined {
  switch (id) {
    case 'savingsRate':  return v === null ? undefined : severityColor(savingsRateSeverity(v));
    case 'cashRunway':   return severityColor(runwaySeverity(v as number, 6, 3));
    case 'liquidRunway': return severityColor(runwaySeverity(v as number, 12, 6));
    case 'debtPayoff':   return v === null ? undefined : severityColor(debtPayoffSeverity(v, 6, 24));
    case 'retirement':   return C_POSITIVE;
    case 'yearsToFire':  return v === null ? C_WARNING : v === 0 ? C_POSITIVE : C_ACCENT;
    case 'coastFire':    return v === null ? undefined : v === 0 ? C_POSITIVE : C_ACCENT;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

const DEFAULT_HEALTH: HealthData = { avgMonthlyExpenses: 0, monthlyIncome: 0, monthlySavings: 0, cash: 0, liquid: 0, retirement: 0, totalDebt: 0, loanDebt: 0, netWorth: 0, basis: 'trailing-365d', basisLabel: BASIS_LABEL['trailing-365d'] };

export function Health({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const [data, setData] = useState<HealthData>(DEFAULT_HEALTH);

  const [dialIdx, setDialIdx]           = useState(0);
  const [monthlySpend, setMonthlySpend] = useState(SPEND_STEP);
  const [monthlySavings, setMonthlySavings] = useState(0);
  const [pretaxSavings, setPretaxSavings] = useState(0);
  const [editMode, setEditMode]         = useState(false);
  const [editBuffer, setEditBuffer]     = useState('');

  useEffect(() => {
    void Promise.all([loadHealthData(), getSetting(PRETAX_MONTHLY_KEY)]).then(([d, pretax]) => {
      setData(d);
      setMonthlySpend(Math.max(SPEND_STEP, Math.round(d.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP));
      setMonthlySavings(Math.round(d.monthlySavings / SPEND_STEP) * SPEND_STEP);
      setPretaxSavings(pretax ? Math.round(parseFloat(pretax) / SPEND_STEP) * SPEND_STEP : 0);
    });
  }, [refreshKey]);

  const [withdrawal, setWithdrawal]     = useState(DEFAULT_WITHDRAWAL);
  const [growth, setGrowth]             = useState(DEFAULT_GROWTH);

  // 'none' = normal Snapshot/Runway/Debt/Retirement/Assumptions view; 'compact'
  // = fixed-metric recent-trend view (first [t]); 'full' = metric/range/
  // pagination drill-down (second [t]). [Esc] backs out one tier at a time,
  // mirroring NetWorth.tsx's filterMode nesting.
  const [historyTier, setHistoryTier]     = useState<'none' | 'compact' | 'full'>('none');
  const [historyRange, setHistoryRange]   = useState<HistoryRange>('month');
  const [historyRows, setHistoryRows]     = useState<HealthHistoryPeriod[]>([]);
  const [metricIdx, setMetricIdx]         = useState(0);
  const [historyCursor, setHistoryCursor] = useState(0);

  const historyGuard = useLoadGuard();
  useEffect(() => {
    const token = historyGuard.begin();
    void getHealthHistory(historyRange).then((rows) => {
      if (!historyGuard.isLatest(token)) return;
      setHistoryRows(rows);
      setHistoryCursor(Math.max(0, rows.length - 1));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRange, refreshKey]);

  const currentDial: Dial = DIALS[dialIdx];

  function currentDialValueStr(): string {
    if (currentDial === 'spend')      return String(monthlySpend);
    if (currentDial === 'savings')    return String(monthlySavings);
    if (currentDial === 'pretax')     return String(pretaxSavings);
    if (currentDial === 'withdrawal') return String(withdrawal);
    if (currentDial === 'growth')     return String(growth);
    return '';
  }

  function applyEdit(buffer: string) {
    const n = parseFloat(buffer);
    if (!isNaN(n)) {
      if (currentDial === 'spend')      setMonthlySpend(Math.max(SPEND_STEP, Math.round(n / SPEND_STEP) * SPEND_STEP));
      if (currentDial === 'savings')    setMonthlySavings(Math.round(n / SPEND_STEP) * SPEND_STEP);
      if (currentDial === 'pretax') {
        const newValue = Math.max(0, Math.round(n / SPEND_STEP) * SPEND_STEP);
        setPretaxSavings(newValue);
        void setSetting(PRETAX_MONTHLY_KEY, String(newValue));
      }
      if (currentDial === 'withdrawal') setWithdrawal(parseFloat(Math.min(10, Math.max(0.5, n)).toFixed(1)));
      if (currentDial === 'growth')     setGrowth(parseFloat(Math.min(20, Math.max(0, n)).toFixed(1)));
    }
    setEditMode(false);
    setEditBuffer('');
  }

  useInput((input, key) => {
    if (editMode) {
      if (key.escape) { setEditMode(false); setEditBuffer(''); return; }
      if (key.return) { applyEdit(editBuffer); return; }
      if (key.backspace || key.delete) { setEditBuffer((b) => b.slice(0, -1)); return; }
      if (input && /^[\d.\-]$/.test(input) && !key.ctrl && !key.meta) setEditBuffer((b) => b + input);
      return;
    }

    // 'h' is the App-level hints toggle (see App.tsx), so History mode uses 't'
    // instead to avoid firing both handlers on the same keypress.
    if (historyTier === 'full') {
      // Collapsing back to 'compact' always resets the range to 'month' -- the
      // compact tier has no range control, so it must not inherit whatever
      // range the full tier was left on.
      if (key.escape || input === 't') { setHistoryTier('compact'); setHistoryRange('month'); return; }
      if (key.upArrow)    { setHistoryCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow)  { setHistoryCursor((c) => Math.min(historyRows.length - 1, c + 1)); return; }
      if (key.leftArrow)  { setMetricIdx((i) => (i - 1 + HISTORY_METRICS.length) % HISTORY_METRICS.length); return; }
      if (key.rightArrow) { setMetricIdx((i) => (i + 1) % HISTORY_METRICS.length); return; }
      if (input === 'r') {
        setHistoryRange((r) => HISTORY_RANGES[(HISTORY_RANGES.indexOf(r) + 1) % HISTORY_RANGES.length]);
        return;
      }
      return;
    }

    if (historyTier === 'compact') {
      if (key.escape) { setHistoryTier('none'); return; }
      if (input === 't') { setHistoryTier('full'); return; }
      return;
    }

    if (key.escape) { onNavigate('dashboard'); return; }
    if (input === 't') { setHistoryTier('compact'); return; }
    handleNavKey(input, 'health', onNavigate);

    if (key.upArrow)   { setDialIdx((i) => (i - 1 + DIALS.length) % DIALS.length); return; }
    if (key.downArrow) { setDialIdx((i) => (i + 1) % DIALS.length); return; }

    if (key.return) {
      setEditBuffer(currentDialValueStr());
      setEditMode(true);
      return;
    }

    if (key.rightArrow) {
      if (currentDial === 'spend')      setMonthlySpend((s) => s + SPEND_STEP);
      if (currentDial === 'savings')    setMonthlySavings((s) => s + SPEND_STEP);
      if (currentDial === 'pretax') {
        const newValue = pretaxSavings + SPEND_STEP;
        setPretaxSavings(newValue);
        void setSetting(PRETAX_MONTHLY_KEY, String(newValue));
      }
      if (currentDial === 'withdrawal') setWithdrawal((w) => parseFloat(Math.min(10, w + WITHDRAW_STEP).toFixed(1)));
      if (currentDial === 'growth')     setGrowth((g) => parseFloat(Math.min(20, g + GROWTH_STEP).toFixed(1)));
      return;
    }
    if (key.leftArrow) {
      if (currentDial === 'spend')      setMonthlySpend((s) => Math.max(SPEND_STEP, s - SPEND_STEP));
      if (currentDial === 'savings')    setMonthlySavings((s) => s - SPEND_STEP);
      if (currentDial === 'pretax') {
        const newValue = Math.max(0, pretaxSavings - SPEND_STEP);
        setPretaxSavings(newValue);
        void setSetting(PRETAX_MONTHLY_KEY, String(newValue));
      }
      if (currentDial === 'withdrawal') setWithdrawal((w) => parseFloat(Math.max(0.5, w - WITHDRAW_STEP).toFixed(1)));
      if (currentDial === 'growth')     setGrowth((g) => parseFloat(Math.max(0, g - GROWTH_STEP).toFixed(1)));
      return;
    }
    if (input === 'r') {
      if (currentDial === 'spend')      setMonthlySpend(Math.max(SPEND_STEP, Math.round(data.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP));
      if (currentDial === 'savings')    setMonthlySavings(Math.round(data.monthlySavings / SPEND_STEP) * SPEND_STEP);
      if (currentDial === 'pretax') {
        setPretaxSavings(0);
        void setSetting(PRETAX_MONTHLY_KEY, '0');
      }
      if (currentDial === 'withdrawal') setWithdrawal(DEFAULT_WITHDRAWAL);
      if (currentDial === 'growth')     setGrowth(DEFAULT_GROWTH);
      return;
    }
  }, { isActive: isActive !== false });

  // ── Derived ─────────────────────────────────────────────────────────────────
  const {
    annualSpend,
    fireNumber,
    fireProgress,
    cashRunwayMonths: cashMonths,
    liquidRunwayMonths: liquidMonths,
    netCash,
    remainingDebt,
    debtPayoffMonths: debtMonths,
  } = computeFireRunwayMetrics({
    monthlySpend,
    withdrawalRatePct: withdrawal,
    cash: data.cash,
    liquid: data.liquid,
    totalDebt: data.totalDebt,
    monthlySavings, // cash savings only -- NOT combined with pretaxSavings (that combination stays local to yearsToFire below)
    netWorth: data.netWorth,
  });

  const years          = yearsToFire(data.netWorth, monthlySavings + pretaxSavings, fireNumber, growth);
  const coast          = coastYears(data.netWorth, fireNumber, growth);

  const grossIncome    = data.monthlyIncome + pretaxSavings;
  const savingsRate    = computeSavingsRate(data.monthlyIncome, monthlySavings, pretaxSavings);
  const rawSavingsRate = computeSavingsRate(data.monthlyIncome, monthlySavings, 0);

  const defaultSpend    = Math.max(SPEND_STEP, Math.round(data.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP);
  const defaultSavings  = Math.round(data.monthlySavings / SPEND_STEP) * SPEND_STEP;
  const spendChanged    = monthlySpend !== defaultSpend;
  const savingsChanged  = monthlySavings !== defaultSavings;
  const pretaxChanged   = pretaxSavings !== 0;
  const withdrawChanged = withdrawal !== DEFAULT_WITHDRAWAL;
  const growthChanged   = growth !== DEFAULT_GROWTH;

  const L = 18;
  const V = 12;

  // ── History mode derived values ────────────────────────────────────────────
  const historyPoints: HistoryPoint[] = historyRows.map((row) => computeHistoryPoint(row, {
    pretaxSavings,
    fireNumber,
    savingsForFire: monthlySavings + pretaxSavings,
    growth,
  }));
  const currentMetric = HISTORY_METRICS[metricIdx];
  const historyValues = historyPoints.map((p) => HISTORY_VALUE[currentMetric.id](p));
  const historyMax = Math.max(...historyValues.filter((v): v is number => v !== null).map(Math.abs), 1);
  const { visible: visibleHistory, pageStart: historyPageStart } = usePagination(historyPoints, historyCursor, HISTORY_PAGE);
  const historyLabelW = periodLabelWidth(historyRange);

  // Compact tier: last N points, fixed to COMPACT_METRIC, no cursor/pagination.
  const compactPoints = historyPoints.slice(-HISTORY_COMPACT_PERIODS);
  const compactValues = compactPoints.map((p) => HISTORY_VALUE[COMPACT_METRIC.id](p));
  const compactMax = Math.max(...compactValues.filter((v): v is number => v !== null).map(Math.abs), 1);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="health" showHints={showHints} />

      <Box marginTop={1}><Text bold>Financial Health</Text></Box>
      {showHints && (
        editMode
          ? <Text dimColor>type value  ·  Enter confirm  ·  Esc cancel</Text>
          : historyTier === 'full'
            ? <Text dimColor>←→ metric  ·  ↑↓ scroll  ·  [r] range  ·  [t] compact  ·  [Esc] back</Text>
            : historyTier === 'compact'
              ? <Text dimColor>[t] more detail  ·  [Esc] back</Text>
              : <Text dimColor>↑↓ select  ·  ← → adjust  ·  Enter type  ·  [r] reset  ·  [t] history</Text>
      )}
      <Divider />

      {historyTier === 'full' ? (
        <Box flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between">
            <Text bold>History — {currentMetric.label}</Text>
            <Box gap={2}>
              {HISTORY_RANGES.map((r) => (
                <Text key={r} color={r === historyRange ? C_ACCENT : undefined} dimColor={r !== historyRange} bold={r === historyRange}>
                  {HISTORY_RANGE_LABELS[r]}
                </Text>
              ))}
              {showHints && <Text dimColor>[r]</Text>}
            </Box>
          </Box>
          {currentMetric.needsAssumptionCaption && (
            <Text dimColor>Using today's growth/withdrawal-rate assumptions applied to past balances.</Text>
          )}
          {historyPoints.length === 0 ? (
            <Box marginTop={1}><Text dimColor>No balance history yet.</Text></Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {visibleHistory.map((p, i) => {
                const v = HISTORY_VALUE[currentMetric.id](p);
                const isSelected = historyPageStart + i === historyCursor;
                const color = historyValueColor(currentMetric.id, v);
                return (
                  <Box key={p.period} gap={2}>
                    <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>
                      {periodLabel(p.period, historyRange).padEnd(historyLabelW)}
                    </Text>
                    <Text color={color} dimColor={!isSelected && v === null}>
                      {formatHistoryValue(currentMetric.id, v).padStart(12)}
                    </Text>
                    <Text color={color} dimColor>
                      {bar(v ?? 0, historyMax, HISTORY_BAR_WIDTH)}
                    </Text>
                  </Box>
                );
              })}
              {historyPoints.length > HISTORY_PAGE && (
                <Text dimColor>{historyCursor + 1} / {historyPoints.length}</Text>
              )}
            </Box>
          )}
        </Box>
      ) : historyTier === 'compact' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>History — {COMPACT_METRIC.label}</Text>
          {compactPoints.length === 0 ? (
            <Box marginTop={1}><Text dimColor>No balance history yet.</Text></Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {compactPoints.map((p) => {
                const v = HISTORY_VALUE[COMPACT_METRIC.id](p);
                const color = historyValueColor(COMPACT_METRIC.id, v);
                return (
                  <Box key={p.period} gap={2}>
                    <Text dimColor>{periodLabel(p.period, historyRange).padEnd(historyLabelW)}</Text>
                    <Text color={color} dimColor={v === null}>
                      {formatHistoryValue(COMPACT_METRIC.id, v).padStart(12)}
                    </Text>
                    <Text color={color} dimColor>
                      {bar(v ?? 0, compactMax, HISTORY_BAR_WIDTH)}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
      ) : (
      <>
      {/* ── Snapshot ───────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>SNAPSHOT</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Savings rate'.padEnd(L)}</Text>
          {savingsRate === null ? (
            <Text dimColor>{'—'.padStart(V)}</Text>
          ) : (
            <Text bold color={severityColor(savingsRateSeverity(savingsRate))}>
              {fmtPct(savingsRate).padStart(V)}
            </Text>
          )}
          <Text dimColor>
            {savingsRate === null
              ? 'no income found in transactions'
              : savingsRate < 0
                ? 'spending more than earning'
                : savingsRate < 10
                  ? 'aim for 20%+'
                  : savingsRate < 20
                    ? 'getting there — aim for 20%+'
                    : savingsRate >= 50
                      ? 'FIRE pace'
                      : 'on track'}
            {savingsRate !== null && pretaxSavings > 0 && rawSavingsRate !== null
              ? `  (${fmtPct(rawSavingsRate)} take-home)`
              : ''}
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Monthly income'.padEnd(L)}</Text>
          <Text bold>{fmt(grossIncome).padStart(V)}</Text>
          <Text dimColor>
            {'avg past 12 months'}
            {pretaxSavings > 0 ? `  (${fmt(data.monthlyIncome)} take-home)` : ''}
          </Text>
        </Box>
      </Box>

      {/* ── Runway ─────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>RUNWAY</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Cash'.padEnd(L)}</Text>
          <Text bold color={severityColor(runwaySeverity(cashMonths, 6, 3))}>
            {fmtMonths(cashMonths).padStart(V)}
          </Text>
          <Text dimColor>{fmt(data.cash)} in checking/savings</Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Liquid'.padEnd(L)}</Text>
          <Text bold color={severityColor(runwaySeverity(liquidMonths, 12, 6))}>
            {fmtMonths(liquidMonths).padStart(V)}
          </Text>
          <Text dimColor>{fmt(data.liquid)} incl. brokerage</Text>
        </Box>
      </Box>

      {/* ── Debt (only shown if there is debt) ─────────────────────────────── */}
      {(data.totalDebt > 0 || data.loanDebt > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader>DEBT</SectionHeader>
          {data.loanDebt > 0 && (
            <>
              <Box gap={3} marginTop={1}>
                <Text dimColor>{'Credit cards'.padEnd(L)}</Text>
                <Text bold color={C_NEGATIVE}>{fmt(data.totalDebt).padStart(V)}</Text>
              </Box>
              <Box gap={3}>
                <Text dimColor>{'Loans'.padEnd(L)}</Text>
                <Text bold color={C_NEGATIVE}>{fmt(data.loanDebt).padStart(V)}</Text>
                <Text dimColor>mortgage / auto / student</Text>
              </Box>
              <Box gap={3}>
                <Text dimColor>{'Total'.padEnd(L)}</Text>
                <Text bold color={C_NEGATIVE}>{fmt(data.totalDebt + data.loanDebt).padStart(V)}</Text>
              </Box>
            </>
          )}
          {data.totalDebt > 0 && (
            <>
              <Box gap={3} marginTop={1}>
                <Text dimColor>{'Net cash'.padEnd(L)}</Text>
                <Text bold color={netCash >= 0 ? C_POSITIVE : C_NEGATIVE}>
                  {fmtSigned(netCash).padStart(V)}
                </Text>
                <Text dimColor>
                  {netCash >= 0
                    ? 'could pay off now'
                    : `${fmtCompact(data.cash)} cash · ${fmtCompact(data.totalDebt)} debt`}
                </Text>
              </Box>
              {netCash < 0 && (
                <Box gap={3}>
                  <Text dimColor>{'Debt-free in'.padEnd(L)}</Text>
                  {debtMonths === null ? (
                    <Text color={C_NEGATIVE}>{'no surplus'.padStart(V)}</Text>
                  ) : (
                    <Text bold color={severityColor(debtPayoffSeverity(debtMonths, 6, 24))}>
                      {fmtMonths(debtMonths).padStart(V)}
                    </Text>
                  )}
                  <Text dimColor>
                    {debtMonths !== null ? `${fmtCompact(remainingDebt)} remaining after cash` : 'increase savings to pay off debt'}
                  </Text>
                </Box>
              )}
            </>
          )}
        </Box>
      )}

      {/* ── Retirement ─────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>RETIREMENT</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Net worth'.padEnd(L)}</Text>
          <Text bold color={data.netWorth >= 0 ? C_POSITIVE : C_NEGATIVE}>
            {fmtCompact(data.netWorth).padStart(12)}
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'FIRE number'.padEnd(L)}</Text>
          <Text bold>{fmtCompact(fireNumber).padStart(12)}</Text>
          <Text dimColor>{fmtPct(fireProgress * 100)}</Text>
          <Text color={C_ACCENT} dimColor>{progressBar(fireProgress)}</Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Coast FIRE'.padEnd(L)}</Text>
          {coast === null ? (
            <Text dimColor>{'—'.padStart(12)}</Text>
          ) : coast === 0 ? (
            <Text color={C_POSITIVE} bold>{'Achieved!'.padStart(12)}</Text>
          ) : (
            <Text bold color={C_ACCENT}>{`~${Math.ceil(coast)} yr`.padStart(12)}</Text>
          )}
          <Text dimColor>
            {coast === null
              ? 'need positive net worth'
              : coast === 0
                ? 'growth alone covers retirement'
                : 'if you stop saving now'}
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Est. years away'.padEnd(L)}</Text>
          {years === null ? (
            <Text color={C_WARNING}>{'100+ years'.padStart(12)}</Text>
          ) : years === 0 ? (
            <Text color={C_POSITIVE} bold>{'Achieved!'.padStart(12)}</Text>
          ) : (
            <Text bold color={C_ACCENT}>{`~${Math.ceil(years)} yr`.padStart(12)}</Text>
          )}
        </Box>
      </Box>

      {/* ── Assumptions ────────────────────────────────────────────────────── */}
      <Box marginTop={1}><Divider /></Box>
      <SectionHeader>ASSUMPTIONS</SectionHeader>

      <Box flexDirection="column" marginTop={1}>
        <DialRow
          label="Monthly spending" value={fmt(monthlySpend)} selected={currentDial === 'spend'}
          editing={editMode && currentDial === 'spend'} editBuffer={editBuffer}
          description={editMode && currentDial === 'spend'
            ? 'Enter confirm  ·  Esc cancel'
            : currentDial === 'spend'
              ? (spendChanged ? `default ${fmt(defaultSpend)} · [r] reset` : `avg past 12 months  ← → ±${fmt(SPEND_STEP)}`)
              : `avg past 12 months${spendChanged ? ' (modified)' : ''}`}
        />
        <DialRow
          label="Monthly savings" value={fmtSigned(monthlySavings)} selected={currentDial === 'savings'}
          valueColor={monthlySavings < 0 ? C_NEGATIVE : C_NEUTRAL}
          editing={editMode && currentDial === 'savings'} editBuffer={editBuffer}
          description={editMode && currentDial === 'savings'
            ? 'Enter confirm  ·  Esc cancel'
            : currentDial === 'savings'
              ? (savingsChanged ? `default ${fmt(defaultSavings)} · [r] reset` : `avg surplus past 12 mo  ← → ±${fmt(SPEND_STEP)}`)
              : `avg surplus past 12 mo${savingsChanged ? ' (modified)' : ''}`}
        />
        <DialRow
          label="Pretax savings" value={fmt(pretaxSavings)} selected={currentDial === 'pretax'}
          editing={editMode && currentDial === 'pretax'} editBuffer={editBuffer}
          description={editMode && currentDial === 'pretax'
            ? 'Enter confirm  ·  Esc cancel'
            : currentDial === 'pretax'
              ? (pretaxChanged ? `default $0 · [r] reset` : `401k/HSA — not in transactions  ← → ±${fmt(SPEND_STEP)}`)
              : `401k/HSA — not in transactions${pretaxChanged ? ' (modified)' : ''}`}
        />
        <DialRow
          label="Withdrawal rate" value={fmtPct(withdrawal)} selected={currentDial === 'withdrawal'}
          editing={editMode && currentDial === 'withdrawal'} editBuffer={editBuffer}
          description={editMode && currentDial === 'withdrawal'
            ? 'Enter confirm  ·  Esc cancel'
            : currentDial === 'withdrawal'
              ? `← → ±${fmtPct(WITHDRAW_STEP)}${withdrawChanged ? ' · [r] reset' : ''}`
              : `safe withdrawal rate${withdrawChanged ? ' (modified)' : ''}`}
        />
        <DialRow
          label="Growth rate" value={fmtPct(growth)} selected={currentDial === 'growth'}
          editing={editMode && currentDial === 'growth'} editBuffer={editBuffer}
          description={editMode && currentDial === 'growth'
            ? 'Enter confirm  ·  Esc cancel'
            : currentDial === 'growth'
              ? `← → ±${fmtPct(GROWTH_STEP)}${growthChanged ? ' · [r] reset' : ''}`
              : `real annual return${growthChanged ? ' (modified)' : ''}`}
        />
      </Box>
      </>
      )}
    </Box>
  );
}
