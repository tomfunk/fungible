import { db } from './db.js';
import { calcN } from './calculator.js';
import { TRAILING_12MO_AVERAGES_SQL } from './queries.js';

export type HealthData = {
  avgMonthlyExpenses: number;
  monthlyIncome: number;
  monthlySavings: number;
  savingsRate: number;  // monthlySavings / monthlyIncome as a percentage
  cash: number;
  liquid: number;       // cash + taxable brokerage
  retirement: number;   // 401k / IRA / Roth / HSA — restricted until ~59½
  totalDebt: number;    // credit cards
  loanDebt: number;     // mortgage / auto / student loans
  netWorth: number;
};

export async function loadHealthData(): Promise<HealthData> {
  const [expRes, cashRes, liquidRes, retirementRes, debtRes, loanRes, nwRes] = await Promise.all([
    db.execute(TRAILING_12MO_AVERAGES_SQL),
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
        COALESCE(SUM(CASE WHEN a.type = 'credit' THEN bh.balance ELSE 0 END), 0) AS net_worth
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.excluded = 0
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
  ]);

  const expRow  = expRes.rows[0]        as unknown as { avg_expenses: number; avg_income: number; avg_savings: number };
  const cashRow = cashRes.rows[0]       as unknown as { cash: number };
  const liqRow  = liquidRes.rows[0]     as unknown as { liquid: number };
  const retRow  = retirementRes.rows[0] as unknown as { retirement: number };
  const debtRow = debtRes.rows[0]       as unknown as { total_debt: number };
  const loanRow = loanRes.rows[0]       as unknown as { loan_debt: number };
  const nwRow   = nwRes.rows[0]         as unknown as { net_worth: number };

  const monthlyIncome   = Number(expRow.avg_income);
  const monthlySavings  = Number(expRow.avg_savings);

  return {
    avgMonthlyExpenses: Number(expRow.avg_expenses),
    monthlyIncome,
    monthlySavings,
    savingsRate:        monthlyIncome > 0 ? (monthlySavings / monthlyIncome) * 100 : 0,
    cash:               Number(cashRow.cash),
    liquid:             Number(liqRow.liquid),
    retirement:         Number(retRow.retirement),
    totalDebt:          Number(debtRow.total_debt),
    loanDebt:           Number(loanRow.loan_debt),
    netWorth:           Number(nwRow.net_worth),
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
