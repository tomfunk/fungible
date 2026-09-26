import type { SeverityLevel } from './severity.js';

// Pure FIRE/runway/debt-payoff math and severity bands, split out of
// health.ts so the browser (gui renderer) bundle can import these without
// pulling in db.ts (and its transitive Node-only deps like crypto.ts) --
// see health.ts for the DB-backed pieces (loadHealthData, yearsToFire,
// coastYears, etc.) that legitimately need `db`.

export type FireRunwayInputs = {
  monthlySpend: number;
  withdrawalRatePct: number; // e.g. 4.0
  cash: number;
  liquid: number;
  totalDebt: number;
  monthlySavings: number; // cash savings available for debt payoff -- NOT combined with pretax 401k
  netWorth: number;
};

export type FireRunwayMetrics = {
  annualSpend: number;
  fireNumber: number;
  fireProgress: number; // fireNumber>0 ? max(0,netWorth)/fireNumber : 0
  cashRunwayMonths: number;   // spend>0 ? cash/spend : 0
  liquidRunwayMonths: number; // spend>0 ? liquid/spend : 0
  netCash: number;            // cash - totalDebt
  remainingDebt: number;      // max(0, totalDebt - cash)
  debtPayoffMonths: number | null; // savings>0 ? remainingDebt/savings : null
};

/**
 * Pure port of the FIRE/runway/debt-payoff math that used to live identically
 * inline in gui's Health.tsx and tui's Health.tsx. yearsToFire/coastYears are
 * deliberately NOT folded in here -- they take a pretax-combined savings
 * figure, which stays a caller-side concern (and live in health.ts).
 */
export function computeFireRunwayMetrics(inputs: FireRunwayInputs): FireRunwayMetrics {
  const { monthlySpend, withdrawalRatePct, cash, liquid, totalDebt, monthlySavings, netWorth } = inputs;
  const annualSpend = monthlySpend * 12;
  const fireNumber = annualSpend / (withdrawalRatePct / 100);
  const fireProgress = fireNumber > 0 ? Math.max(0, netWorth) / fireNumber : 0;
  const cashRunwayMonths = monthlySpend > 0 ? cash / monthlySpend : 0;
  const liquidRunwayMonths = monthlySpend > 0 ? liquid / monthlySpend : 0;
  const netCash = cash - totalDebt;
  const remainingDebt = Math.max(0, totalDebt - cash);
  const debtPayoffMonths = monthlySavings > 0 ? remainingDebt / monthlySavings : null;
  return {
    annualSpend,
    fireNumber,
    fireProgress,
    cashRunwayMonths,
    liquidRunwayMonths,
    netCash,
    remainingDebt,
    debtPayoffMonths,
  };
}

export function savingsRateSeverity(ratePct: number): SeverityLevel {
  if (ratePct < 0) return 'bad';
  if (ratePct < 10) return 'caution';
  if (ratePct < 20) return 'neutral';
  return 'good';
}

export function runwaySeverity(months: number, greenAt: number, yellowAt: number): SeverityLevel {
  if (months >= greenAt) return 'good';
  if (months >= yellowAt) return 'caution';
  return 'bad';
}

/**
 * Severity for debt-payoff-months -- the inverse polarity of runwaySeverity:
 * here FEWER months is good, since it's how long debt takes to clear, not
 * how long a cushion lasts. Do not reuse runwaySeverity(debtMonths, 6, 24)
 * for this: its greenAt/yellowAt ordering assumes higher-is-better, so
 * greenAt(6) < yellowAt(24) makes the caution branch unreachable and every
 * debtMonths >= 6 -- including a 24+ month payoff -- would read as "good".
 *
 * Mirrors the original inline gui/tui debt-card logic exactly:
 * `debtMonths <= 6 ? good : debtMonths <= 24 ? caution : neutral`, with
 * `null` (no monthly savings surplus to apply toward debt) treated as bad.
 * null is only ever shown once debt already exceeds cash (netCash < 0), so
 * "no surplus at all" is worse than any of the numeric bands, not better.
 */
export function debtPayoffSeverity(months: number | null, goodAt: number, cautionAt: number): SeverityLevel {
  if (months === null) return 'bad';
  if (months <= goodAt) return 'good';
  if (months <= cautionAt) return 'caution';
  return 'neutral';
}
