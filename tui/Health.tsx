import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { loadHealthData, yearsToFire, coastYears, type HealthData } from '../core/health.js';
import { C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_ACCENT } from './ui.js';
import { useRefreshKey } from './RefreshContext.js';

function savingsRateColor(rate: number): string {
  if (rate < 0)  return C_NEGATIVE;
  if (rate < 10) return C_WARNING;
  if (rate < 20) return C_NEUTRAL;
  return C_POSITIVE;
}

function runwayColor(months: number, green: number, yellow: number): string {
  if (months >= green)  return C_POSITIVE;
  if (months >= yellow) return C_WARNING;
  return C_NEGATIVE;
}
import { fmt, fmtPct, fmtMonths } from './fmt.js';
import { SectionHeader, SelectableRow } from './components/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_WITHDRAWAL    = 4.0;
const DEFAULT_GROWTH        = 7.0;
const SPEND_STEP            = 100;
const WITHDRAW_STEP         = 0.5;
const GROWTH_STEP           = 1.0;
const PROGRESS_BAR_WIDTH    = 22;

const DIALS = ['spend', 'savings', 'withdrawal', 'growth'] as const;
type Dial = typeof DIALS[number];

function progressBar(ratio: number, width = PROGRESS_BAR_WIDTH) {
  const filled = Math.min(width, Math.max(0, Math.round(Math.min(1, ratio) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ─── Component ────────────────────────────────────────────────────────────────

const DEFAULT_HEALTH: HealthData = { avgMonthlyExpenses: 0, monthlyIncome: 0, monthlySavings: 0, cash: 0, liquid: 0, totalDebt: 0, netWorth: 0 };

export function Health({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const [data, setData] = useState<HealthData>(DEFAULT_HEALTH);

  const [dialIdx, setDialIdx]           = useState(0);
  const [monthlySpend, setMonthlySpend] = useState(SPEND_STEP);
  const [monthlySavings, setMonthlySavings] = useState(0);

  useEffect(() => {
    void loadHealthData().then((d) => {
      setData(d);
      setMonthlySpend(Math.max(SPEND_STEP, Math.round(d.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP));
      setMonthlySavings(Math.round(d.monthlySavings / SPEND_STEP) * SPEND_STEP);
    });
  }, [refreshKey]);
  const [withdrawal, setWithdrawal]     = useState(DEFAULT_WITHDRAWAL);
  const [growth, setGrowth]             = useState(DEFAULT_GROWTH);

  const currentDial: Dial = DIALS[dialIdx];

  useInput((input, key) => {
    if (key.escape) { onNavigate('dashboard'); return; }
    handleNavKey(input, 'health', onNavigate);

    if (key.upArrow)   { setDialIdx((i) => (i - 1 + DIALS.length) % DIALS.length); return; }
    if (key.downArrow) { setDialIdx((i) => (i + 1) % DIALS.length); return; }

    if (key.rightArrow) {
      if (currentDial === 'spend')      setMonthlySpend((s) => s + SPEND_STEP);
      if (currentDial === 'savings')    setMonthlySavings((s) => s + SPEND_STEP);
      if (currentDial === 'withdrawal') setWithdrawal((w) => parseFloat(Math.min(10, w + WITHDRAW_STEP).toFixed(1)));
      if (currentDial === 'growth')     setGrowth((g) => parseFloat(Math.min(20, g + GROWTH_STEP).toFixed(1)));
      return;
    }
    if (key.leftArrow) {
      if (currentDial === 'spend')      setMonthlySpend((s) => Math.max(SPEND_STEP, s - SPEND_STEP));
      if (currentDial === 'savings')    setMonthlySavings((s) => s - SPEND_STEP);
      if (currentDial === 'withdrawal') setWithdrawal((w) => parseFloat(Math.max(0.5, w - WITHDRAW_STEP).toFixed(1)));
      if (currentDial === 'growth')     setGrowth((g) => parseFloat(Math.max(0, g - GROWTH_STEP).toFixed(1)));
      return;
    }
    if (input === 'r') {
      if (currentDial === 'spend')      setMonthlySpend(Math.max(SPEND_STEP, Math.round(data.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP));
      if (currentDial === 'savings')    setMonthlySavings(Math.round(data.monthlySavings / SPEND_STEP) * SPEND_STEP);
      if (currentDial === 'withdrawal') setWithdrawal(DEFAULT_WITHDRAWAL);
      if (currentDial === 'growth')     setGrowth(DEFAULT_GROWTH);
      return;
    }
  }, { isActive: isActive !== false });

  // ── Derived ─────────────────────────────────────────────────────────────────
  const cashMonths   = monthlySpend > 0 ? data.cash   / monthlySpend : 0;
  const liquidMonths = monthlySpend > 0 ? data.liquid / monthlySpend : 0;

  const annualSpend    = monthlySpend * 12;
  const fireNumber     = annualSpend / (withdrawal / 100);
  const fireProgress   = fireNumber > 0 ? Math.max(0, data.netWorth) / fireNumber : 0;
  const years          = yearsToFire(data.netWorth, monthlySavings, fireNumber, growth);
  const coast          = coastYears(data.netWorth, fireNumber, growth);

  const savingsRate = data.monthlyIncome > 0
    ? (monthlySavings / data.monthlyIncome) * 100
    : null;

  const netCash        = data.cash - data.totalDebt;
  const remainingDebt  = Math.max(0, data.totalDebt - data.cash);
  const debtMonths     = monthlySavings > 0 ? remainingDebt / monthlySavings : null;

  const defaultSpend    = Math.max(SPEND_STEP, Math.round(data.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP);
  const defaultSavings  = Math.round(data.monthlySavings / SPEND_STEP) * SPEND_STEP;
  const spendChanged    = monthlySpend !== defaultSpend;
  const savingsChanged  = monthlySavings !== defaultSavings;
  const withdrawChanged = withdrawal !== DEFAULT_WITHDRAWAL;
  const growthChanged   = growth !== DEFAULT_GROWTH;

  const L = 18;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Nav */}
      <Box justifyContent="space-between">
        <Text bold color={C_ACCENT}>fungible</Text>
        <NavHints current="health" showHints={showHints} />
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text bold>Financial Health</Text>
        {showHints && <Text dimColor>↑↓ select  ·  ← → adjust  ·  [r] reset</Text>}
      </Box>
      <Divider />

      {/* ── Snapshot ───────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>SNAPSHOT</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Savings rate'.padEnd(L)}</Text>
          {savingsRate === null ? (
            <Text dimColor>{'—'.padStart(8)}</Text>
          ) : (
            <Text bold color={savingsRateColor(savingsRate)}>
              {fmtPct(savingsRate).padStart(8)}
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
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Monthly income'.padEnd(L)}</Text>
          <Text bold>{fmt(data.monthlyIncome).padStart(8)}</Text>
          <Text dimColor>avg past 12 months</Text>
        </Box>
      </Box>

      {/* ── Runway ─────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>RUNWAY</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Cash'.padEnd(L)}</Text>
          <Text bold color={runwayColor(cashMonths, 6, 3)}>
            {fmtMonths(cashMonths).padStart(8)}
          </Text>
          <Text dimColor>{fmt(data.cash)} in checking/savings</Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Liquid'.padEnd(L)}</Text>
          <Text bold color={runwayColor(liquidMonths, 12, 6)}>
            {fmtMonths(liquidMonths).padStart(8)}
          </Text>
          <Text dimColor>{fmt(data.liquid)} incl. brokerage</Text>
        </Box>
      </Box>

      {/* ── Debt (only shown if there is debt) ─────────────────────────────── */}
      {data.totalDebt > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader>DEBT</SectionHeader>
          <Box gap={3} marginTop={1}>
            <Text dimColor>{'Net cash'.padEnd(L)}</Text>
            <Text bold color={netCash >= 0 ? C_POSITIVE : C_NEGATIVE}>
              {(netCash < 0 ? '-' : '') + fmt(netCash).padStart(8)}
            </Text>
            <Text dimColor>
              {netCash >= 0
                ? `${fmt(data.cash)} cash · ${fmt(data.totalDebt)} debt — could pay off now`
                : `${fmt(data.cash)} cash · ${fmt(data.totalDebt)} debt`}
            </Text>
          </Box>
          {netCash < 0 && (
            <Box gap={3}>
              <Text dimColor>{'Debt-free in'.padEnd(L)}</Text>
              {debtMonths === null ? (
                <Text color={C_NEGATIVE}>{'no surplus'.padStart(8)}</Text>
              ) : (
                <Text bold color={debtMonths <= 6 ? C_POSITIVE : debtMonths <= 24 ? C_WARNING : C_NEUTRAL}>
                  {fmtMonths(debtMonths).padStart(8)}
                </Text>
              )}
              <Text dimColor>
                {debtMonths !== null ? `${fmt(remainingDebt)} remaining after cash` : 'increase savings to pay off debt'}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* ── Retirement ─────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>RETIREMENT</SectionHeader>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Net worth'.padEnd(L)}</Text>
          <Text bold color={data.netWorth >= 0 ? C_POSITIVE : C_NEGATIVE}>
            {fmt(data.netWorth).padStart(12)}
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'FIRE number'.padEnd(L)}</Text>
          <Text bold>{fmt(fireNumber).padStart(12)}</Text>
          <Text dimColor>  {fmtPct(fireProgress * 100)}</Text>
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
        <SelectableRow selected={currentDial === 'spend'} gap={2}>
          <Text color={currentDial === 'spend' ? C_ACCENT : undefined}>{'Monthly spending'.padEnd(16)}</Text>
          <Text color={currentDial === 'spend' ? C_ACCENT : C_NEUTRAL}>{'[ '}{fmt(monthlySpend).padStart(8)}{' ]'}</Text>
          <Text dimColor>
            {currentDial === 'spend'
              ? (spendChanged ? `default ${fmt(defaultSpend)} · [r] reset` : `avg past 12 months  ← → ±${fmt(SPEND_STEP)}`)
              : `avg past 12 months${spendChanged ? ' (modified)' : ''}`}
          </Text>
        </SelectableRow>

        <SelectableRow selected={currentDial === 'savings'} gap={2}>
          <Text color={currentDial === 'savings' ? C_ACCENT : undefined}>{'Monthly savings'.padEnd(16)}</Text>
          <Text color={currentDial === 'savings' ? C_ACCENT : C_NEUTRAL}>{'[ '}{fmt(monthlySavings).padStart(8)}{' ]'}</Text>
          <Text dimColor>
            {currentDial === 'savings'
              ? (savingsChanged ? `default ${fmt(defaultSavings)} · [r] reset` : `avg surplus past 12 mo  ← → ±${fmt(SPEND_STEP)}`)
              : `avg surplus past 12 mo${savingsChanged ? ' (modified)' : ''}`}
          </Text>
        </SelectableRow>

        <SelectableRow selected={currentDial === 'withdrawal'} gap={2}>
          <Text color={currentDial === 'withdrawal' ? C_ACCENT : undefined}>{'Withdrawal rate'.padEnd(16)}</Text>
          <Text color={currentDial === 'withdrawal' ? C_ACCENT : C_NEUTRAL}>{'[ '}{fmtPct(withdrawal).padStart(8)}{' ]'}</Text>
          <Text dimColor>
            {currentDial === 'withdrawal'
              ? `↑↓ ±${fmtPct(WITHDRAW_STEP)}${withdrawChanged ? ' · [r] reset' : ''}`
              : `safe withdrawal rate${withdrawChanged ? ' (modified)' : ''}`}
          </Text>
        </SelectableRow>

        <SelectableRow selected={currentDial === 'growth'} gap={2}>
          <Text color={currentDial === 'growth' ? C_ACCENT : undefined}>{'Growth rate'.padEnd(16)}</Text>
          <Text color={currentDial === 'growth' ? C_ACCENT : C_NEUTRAL}>{'[ '}{fmtPct(growth).padStart(8)}{' ]'}</Text>
          <Text dimColor>
            {currentDial === 'growth'
              ? `↑↓ ±${fmtPct(GROWTH_STEP)}${growthChanged ? ' · [r] reset' : ''}`
              : `real annual return${growthChanged ? ' (modified)' : ''}`}
          </Text>
        </SelectableRow>
      </Box>
    </Box>
  );
}
