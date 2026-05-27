import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { loadHealthData, yearsToFire, coastYears, savingsRateColor, runwayColor, type HealthData } from '../core/health.js';
import { fmt, fmtPct, fmtMonths } from '../core/fmt.js';

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

export function Health({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen) => void; isActive?: boolean; showHints: boolean }) {
  const [data] = useState<HealthData>(loadHealthData);

  const defaultSpend   = Math.max(SPEND_STEP, Math.round(data.avgMonthlyExpenses / SPEND_STEP) * SPEND_STEP);
  const defaultSavings = Math.round(data.monthlySavings / SPEND_STEP) * SPEND_STEP;

  const [dialIdx, setDialIdx]           = useState(0);
  const [monthlySpend, setMonthlySpend] = useState(defaultSpend);
  const [monthlySavings, setMonthlySavings] = useState(defaultSavings);
  const [withdrawal, setWithdrawal]     = useState(DEFAULT_WITHDRAWAL);
  const [growth, setGrowth]             = useState(DEFAULT_GROWTH);

  const currentDial: Dial = DIALS[dialIdx];

  useInput((input, key) => {
    if (key.escape || input === '6') { onNavigate('health'); return; }
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
      if (currentDial === 'spend')      setMonthlySpend(defaultSpend);
      if (currentDial === 'savings')    setMonthlySavings(defaultSavings);
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

  const spendChanged    = monthlySpend !== defaultSpend;
  const savingsChanged  = monthlySavings !== defaultSavings;
  const withdrawChanged = withdrawal !== DEFAULT_WITHDRAWAL;
  const growthChanged   = growth !== DEFAULT_GROWTH;

  const L = 18;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Nav */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="health" showHints={showHints} />
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text bold>Financial Health</Text>
        {showHints && <Text dimColor>↑↓ select  ·  ← → adjust  ·  [r] reset</Text>}
      </Box>
      <Divider />

      {/* ── Snapshot ───────────────────────────────────────────────────────── */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>SNAPSHOT</Text>
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
        <Text bold dimColor>RUNWAY</Text>
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
          <Text bold dimColor>DEBT</Text>
          <Box gap={3} marginTop={1}>
            <Text dimColor>{'Net cash'.padEnd(L)}</Text>
            <Text bold color={netCash >= 0 ? 'green' : 'red'}>
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
                <Text color="red">{'no surplus'.padStart(8)}</Text>
              ) : (
                <Text bold color={debtMonths <= 6 ? 'green' : debtMonths <= 24 ? 'yellow' : 'white'}>
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
        <Text bold dimColor>RETIREMENT</Text>
        <Box gap={3} marginTop={1}>
          <Text dimColor>{'Net worth'.padEnd(L)}</Text>
          <Text bold color={data.netWorth >= 0 ? 'green' : 'red'}>
            {fmt(data.netWorth).padStart(12)}
          </Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'FIRE number'.padEnd(L)}</Text>
          <Text bold>{fmt(fireNumber).padStart(12)}</Text>
          <Text dimColor>  {fmtPct(fireProgress * 100)}</Text>
          <Text color="cyan" dimColor>{progressBar(fireProgress)}</Text>
        </Box>
        <Box gap={3}>
          <Text dimColor>{'Coast FIRE'.padEnd(L)}</Text>
          {coast === null ? (
            <Text dimColor>{'—'.padStart(12)}</Text>
          ) : coast === 0 ? (
            <Text color="green" bold>{'Achieved!'.padStart(12)}</Text>
          ) : (
            <Text bold color="cyan">{`~${Math.ceil(coast)} yr`.padStart(12)}</Text>
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
            <Text color="yellow">{'100+ years'.padStart(12)}</Text>
          ) : years === 0 ? (
            <Text color="green" bold>{'Achieved!'.padStart(12)}</Text>
          ) : (
            <Text bold color="cyan">{`~${Math.ceil(years)} yr`.padStart(12)}</Text>
          )}
        </Box>
      </Box>

      {/* ── Assumptions ────────────────────────────────────────────────────── */}
      <Box marginTop={1}><Divider /></Box>
      <Text bold dimColor>ASSUMPTIONS</Text>

      <Box flexDirection="column" marginTop={1}>
        <Box gap={2}>
          <Text color={currentDial === 'spend' ? 'cyan' : undefined}>
            {currentDial === 'spend' ? '▶' : ' '} {'Monthly spending'.padEnd(16)}
          </Text>
          <Text color={currentDial === 'spend' ? 'cyan' : 'white'}>
            {'[ '}{fmt(monthlySpend).padStart(8)}{' ]'}
          </Text>
          <Text dimColor>
            {currentDial === 'spend'
              ? (spendChanged ? `default ${fmt(defaultSpend)} · [r] reset` : `avg past 12 months  ← → ±${fmt(SPEND_STEP)}`)
              : `avg past 12 months${spendChanged ? ' (modified)' : ''}`}
          </Text>
        </Box>

        <Box gap={2}>
          <Text color={currentDial === 'savings' ? 'cyan' : undefined}>
            {currentDial === 'savings' ? '▶' : ' '} {'Monthly savings'.padEnd(16)}
          </Text>
          <Text color={currentDial === 'savings' ? 'cyan' : 'white'}>
            {'[ '}{fmt(monthlySavings).padStart(8)}{' ]'}
          </Text>
          <Text dimColor>
            {currentDial === 'savings'
              ? (savingsChanged ? `default ${fmt(defaultSavings)} · [r] reset` : `avg surplus past 12 mo  ← → ±${fmt(SPEND_STEP)}`)
              : `avg surplus past 12 mo${savingsChanged ? ' (modified)' : ''}`}
          </Text>
        </Box>

        <Box gap={2}>
          <Text color={currentDial === 'withdrawal' ? 'cyan' : undefined}>
            {currentDial === 'withdrawal' ? '▶' : ' '} {'Withdrawal rate'.padEnd(16)}
          </Text>
          <Text color={currentDial === 'withdrawal' ? 'cyan' : 'white'}>
            {'[ '}{fmtPct(withdrawal).padStart(8)}{' ]'}
          </Text>
          <Text dimColor>
            {currentDial === 'withdrawal'
              ? `↑↓ ±${fmtPct(WITHDRAW_STEP)}${withdrawChanged ? ' · [r] reset' : ''}`
              : `safe withdrawal rate${withdrawChanged ? ' (modified)' : ''}`}
          </Text>
        </Box>

        <Box gap={2}>
          <Text color={currentDial === 'growth' ? 'cyan' : undefined}>
            {currentDial === 'growth' ? '▶' : ' '} {'Growth rate'.padEnd(16)}
          </Text>
          <Text color={currentDial === 'growth' ? 'cyan' : 'white'}>
            {'[ '}{fmtPct(growth).padStart(8)}{' ]'}
          </Text>
          <Text dimColor>
            {currentDial === 'growth'
              ? `↑↓ ±${fmtPct(GROWTH_STEP)}${growthChanged ? ' · [r] reset' : ''}`
              : `real annual return${growthChanged ? ' (modified)' : ''}`}
          </Text>
        </Box>

      </Box>
    </Box>
  );
}
