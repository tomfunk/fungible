import { db } from './db.js';

export type HealthData = {
  avgMonthlyExpenses: number;
  monthlyIncome: number;
  monthlySavings: number;
  cash: number;
  liquid: number;
  totalDebt: number;
  netWorth: number;
};

export async function loadHealthData(): Promise<HealthData> {
  const [expRes, cashRes, liquidRes, debtRes, nwRes] = await Promise.all([
    db.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) / 12.0  AS avg_expenses,
        COALESCE(-SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) / 12.0 AS avg_income,
        COALESCE(
          -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) -
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),
          0
        ) / 12.0 AS avg_savings
      FROM transactions
      WHERE date >= date('now', '-12 months')
        AND pending = 0 AND ignored = 0
        AND category NOT IN (SELECT category FROM hidden_categories)
        AND category != 'Transfer'
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS cash
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'depository'
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
      AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT COALESCE(SUM(bh.balance), 0) AS total_debt
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE a.type = 'credit'
        AND bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
    db.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN a.type IN ('depository','investment') OR (a.type = 'other' AND bh.balance > 0) THEN bh.balance ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN a.type = 'credit' THEN bh.balance ELSE 0 END), 0) AS net_worth
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    `),
  ]);

  const expRow  = expRes.rows[0]  as unknown as { avg_expenses: number; avg_income: number; avg_savings: number };
  const cashRow = cashRes.rows[0] as unknown as { cash: number };
  const liqRow  = liquidRes.rows[0] as unknown as { liquid: number };
  const debtRow = debtRes.rows[0] as unknown as { total_debt: number };
  const nwRow   = nwRes.rows[0]   as unknown as { net_worth: number };

  return {
    avgMonthlyExpenses: Number(expRow.avg_expenses),
    monthlyIncome:      Number(expRow.avg_income),
    monthlySavings:     Number(expRow.avg_savings),
    cash:               Number(cashRow.cash),
    liquid:             Number(liqRow.liquid),
    totalDebt:          Number(debtRow.total_debt),
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
  let wealth = netWorth;
  for (let month = 1; month <= 1200; month++) {
    wealth = wealth * (1 + r) + monthlySavings;
    if (wealth >= target) return month / 12;
  }
  return null;
}

export function coastYears(
  netWorth: number,
  fireNumber: number,
  growthPct: number,
): number | null {
  if (netWorth <= 0 || fireNumber <= 0) return null;
  if (netWorth >= fireNumber) return 0;
  const yr = Math.log(fireNumber / netWorth) / Math.log(1 + growthPct / 100);
  return yr > 200 ? null : yr;
}
