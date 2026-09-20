import { db } from './db.js';
import { calcN } from './calculator.js';
import { TRAILING_12MO_AVERAGES_SQL } from './queries.js';
import { BASIS_LABEL, type MetricBasis } from './dateUtils.js';
import type { SeverityLevel } from './severity.js';

export type HealthData = {
  avgMonthlyExpenses: number;
  monthlyIncome: number;
  monthlySavings: number;
  cash: number;
  liquid: number;       // cash + taxable brokerage
  retirement: number;   // 401k / IRA / Roth / HSA — restricted until ~59½
  totalDebt: number;    // credit cards
  loanDebt: number;     // mortgage / auto / student loans
  netWorth: number;
  basis: MetricBasis;   // which "12-month average" definition avgMonthlyExpenses/monthlyIncome/monthlySavings use
  basisLabel: string;
};

export type Trailing12moAverages = {
  avgExpenses: number;
  avgIncome: number;
  avgSavings: number;
  basis: MetricBasis;
  basisLabel: string;
};

/**
 * Trailing-365-day income/expense/savings averages (rolling `date('now','-12
 * months')` window, not aligned to calendar months). Shared by loadHealthData
 * (TUI/GUI Health tab) and getFinancialHealth (agent), which must not drift
 * apart — see TRAILING_12MO_AVERAGES_SQL for the SQL itself.
 *
 * This is one of two "12-month average" definitions in the app (see issue
 * #178) — the other is the drift/scorecard's calendar-12mo baseline
 * (queries.ts sliceFor). Every consumer carries basis/basisLabel so surfaces
 * can say which one they're quoting instead of both being called the same
 * generic name.
 */
export async function getTrailing12moAverages(): Promise<Trailing12moAverages> {
  const result = await db.execute(TRAILING_12MO_AVERAGES_SQL);
  const row = result.rows[0] as unknown as { avg_expenses: number; avg_income: number; avg_savings: number };
  const basis: MetricBasis = 'trailing-365d';
  return {
    avgExpenses: Number(row.avg_expenses),
    avgIncome:   Number(row.avg_income),
    avgSavings:  Number(row.avg_savings),
    basis,
    basisLabel: BASIS_LABEL[basis],
  };
}

export async function loadHealthData(): Promise<HealthData> {
  const [avgs, cashRes, liquidRes, retirementRes, debtRes, loanRes, nwRes] = await Promise.all([
    getTrailing12moAverages(),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS cash
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'depository'
        AND a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS liquid
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE (
        a.type = 'depository'
        OR (a.type = 'investment' AND LOWER(COALESCE(a.subtype, ''))
            IN ('brokerage', 'cash isa', 'non-taxable brokerage account'))
      )
      AND a.excluded = 0
      AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS retirement
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'investment'
        AND LOWER(COALESCE(a.subtype, '')) IN (
          'ira', '401k', 'roth', '403b', '457b', 'hsa',
          'roth 401k', 'simple ira', 'sep ira', 'pension'
        )
        AND a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS total_debt
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'credit'
        AND a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS loan_debt
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'loan'
        AND a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN a.type IN ('depository','investment') OR (a.type = 'other' AND bh.balance > 0) THEN bh.balance ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN a.type IN ('credit','loan') THEN bh.balance ELSE 0 END), 0) AS net_worth
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
  ]);

  const cashRow = cashRes.rows[0]       as unknown as { cash: number };
  const liqRow  = liquidRes.rows[0]     as unknown as { liquid: number };
  const retRow  = retirementRes.rows[0] as unknown as { retirement: number };
  const debtRow = debtRes.rows[0]       as unknown as { total_debt: number };
  const loanRow = loanRes.rows[0]       as unknown as { loan_debt: number };
  const nwRow   = nwRes.rows[0]         as unknown as { net_worth: number };

  return {
    avgMonthlyExpenses: avgs.avgExpenses,
    monthlyIncome:      avgs.avgIncome,
    monthlySavings:     avgs.avgSavings,
    cash:               Number(cashRow.cash),
    liquid:             Number(liqRow.liquid),
    retirement:         Number(retRow.retirement),
    totalDebt:          Number(debtRow.total_debt),
    loanDebt:           Number(loanRow.loan_debt),
    netWorth:           Number(nwRow.net_worth),
    basis:              avgs.basis,
    basisLabel:         avgs.basisLabel,
  };
}

export function yearsToFire(
  netWorth: number,
  monthlySavings: number,
  target: number,
  annualGrowthPct: number,
): number | null {
  if (target <= 0) return 0;
  if (netWorth >= target) return 0;
  const r = Math.pow(1 + annualGrowthPct / 100, 1 / 12) - 1;
  try {
    const months = calcN(-netWorth, target, -monthlySavings, r);
    return isFinite(months) && months > 0 && months <= 1200 ? months / 12 : null;
  } catch {
    return null;
  }
}

export function coastYears(
  netWorth: number,
  fireNumber: number,
  growthPct: number,
): number | null {
  if (netWorth <= 0 || fireNumber <= 0) return null;
  if (netWorth >= fireNumber) return 0;
  try {
    const yr = calcN(-netWorth, fireNumber, 0, growthPct / 100);
    return isFinite(yr) && yr > 0 && yr <= 200 ? yr : null;
  } catch {
    return null;
  }
}

export { computeSavingsRate } from './savings-rate.js';

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
 * figure, which stays a caller-side concern.
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
