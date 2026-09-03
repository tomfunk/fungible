/**
 * Data query functions for the fungible agent.
 * Covers gaps not addressed by the existing MCP tools:
 * account balances, financial health metrics, and spending trends.
 */

import { db } from './db.js';
import { yearsToFire } from './health.js';
import { getSetting, PRETAX_MONTHLY_KEY } from './settings.js';
import { isAssetAccount, isLiabilityAccount } from './account-class.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AccountWithBalance = {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  institution: string | null;
  mask: string | null;
  balance: number;
  isAsset: boolean;
  isLiability: boolean;
};

export type BalanceSummary = {
  accounts: AccountWithBalance[];          // counted toward net worth
  excludedAccounts: AccountWithBalance[];  // visible but excluded from net worth
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  cash: number;        // depository only
  liquid: number;      // depository + taxable brokerage
  retirement: number;  // 401k / IRA / Roth / HSA
  loanDebt: number;    // mortgage / auto / student loans
};

export type FinancialHealth = {
  netWorth: number;
  cash: number;
  liquid: number;
  retirement: number;
  loanDebt: number;
  avgMonthlyExpenses: number;
  avgMonthlyIncome: number;
  avgMonthlySavings: number;
  pretaxMonthly: number;       // from settings; 401k/HSA not in transactions
  grossMonthlyIncome: number;  // avgMonthlyIncome + pretaxMonthly
  savingsRate: number | null;  // (avgMonthlySavings + pretax) / grossIncome
  cashRunwayMonths: number;
  liquidRunwayMonths: number;
  fireNumber: number;          // at 4% withdrawal
  fireProgress: number;        // 0–1 ratio
  yearsToFire: number | null;  // null = >100 years; includes pretax in savings
};

export type MonthlyTrendRow = {
  year: number;
  month: number;
  label: string;   // "Jan 2025"
  income: number;
  expenses: number;
  net: number;
  category?: string;
  categoryTotal?: number;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Balances ─────────────────────────────────────────────────────────────────

export async function getBalances(): Promise<BalanceSummary> {
  const result = await db.execute(`
    SELECT
      a.id, COALESCE(a.nickname, a.name) as name, a.type, a.subtype,
      a.institution_name as institution,
      a.mask, a.excluded,
      bh.balance
    FROM accounts a
    JOIN balance_history bh ON bh.account_id = a.id
    WHERE bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
    ORDER BY
      CASE a.type
        WHEN 'depository'  THEN 0
        WHEN 'investment'  THEN 1
        WHEN 'other'       THEN 2
        WHEN 'credit'      THEN 3
        ELSE 4
      END,
      bh.balance DESC
  `);
  const rows = result.rows as unknown as (Omit<AccountWithBalance, 'isAsset' | 'isLiability'> & { excluded: number })[];

  const toAccount = ({ excluded: _excluded, ...r }: typeof rows[number]): AccountWithBalance => ({
    ...r,
    balance: Number(r.balance),
    isAsset: isAssetAccount({ type: r.type, balance: Number(r.balance) }),
    isLiability: isLiabilityAccount(r),
  });

  // Net-worth totals are computed on the included set; excluded accounts stay
  // visible (carved-out section in the UI and MCP) but never affect the totals.
  const accounts = rows.filter((r) => r.excluded !== 1).map(toAccount);
  const excludedAccounts = rows.filter((r) => r.excluded === 1).map(toAccount);

  const totalAssets = accounts
    .filter((a) => a.isAsset)
    .reduce((s, a) => s + a.balance, 0);

  const totalLiabilities = accounts
    .filter((a) => a.isLiability)
    .reduce((s, a) => s + a.balance, 0);

  const cash = accounts
    .filter((a) => a.type === 'depository')
    .reduce((s, a) => s + a.balance, 0);

  const LIQUID_SUBTYPES     = new Set(['brokerage', 'cash isa', 'non-taxable brokerage account']);
  const RETIREMENT_SUBTYPES = new Set(['ira', '401k', 'roth', '403b', '457b', 'hsa', 'roth 401k', 'simple ira', 'sep ira', 'pension']);

  const liquid = accounts
    .filter((a) =>
      a.type === 'depository' ||
      (a.type === 'investment' && LIQUID_SUBTYPES.has((a.subtype ?? '').toLowerCase()))
    )
    .reduce((s, a) => s + a.balance, 0);

  const retirement = accounts
    .filter((a) => a.type === 'investment' && RETIREMENT_SUBTYPES.has((a.subtype ?? '').toLowerCase()))
    .reduce((s, a) => s + a.balance, 0);

  const loanDebt = accounts
    .filter((a) => a.type === 'loan')
    .reduce((s, a) => s + a.balance, 0);

  return {
    accounts,
    excludedAccounts,
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    cash,
    liquid,
    retirement,
    loanDebt,
  };
}

// ─── Financial Health ─────────────────────────────────────────────────────────

export async function getFinancialHealth(
  withdrawalRate = 4,
  annualGrowthPct = 7,
): Promise<FinancialHealth> {
  const balances = await getBalances();

  const [expResult, pretaxRaw] = await Promise.all([
    db.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) / 12.0 AS avg_expenses,
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
    getSetting(PRETAX_MONTHLY_KEY),
  ]);
  const expRow = expResult.rows[0] as unknown as { avg_expenses: number; avg_income: number; avg_savings: number };

  const avgMonthlyExpenses = Number(expRow.avg_expenses);
  const avgMonthlyIncome   = Number(expRow.avg_income);
  const avgMonthlySavings  = Number(expRow.avg_savings);
  const pretaxMonthly      = pretaxRaw ? parseFloat(pretaxRaw) : 0;
  const grossMonthlyIncome = avgMonthlyIncome + pretaxMonthly;
  const savingsRate        = grossMonthlyIncome > 0
    ? ((avgMonthlySavings + pretaxMonthly) / grossMonthlyIncome) * 100
    : null;

  const cashRunwayMonths   = avgMonthlyExpenses > 0 ? balances.cash   / avgMonthlyExpenses : 0;
  const liquidRunwayMonths = avgMonthlyExpenses > 0 ? balances.liquid / avgMonthlyExpenses : 0;

  const annualSpend = avgMonthlyExpenses * 12;
  const fireNumber  = annualSpend / (withdrawalRate / 100);
  const fireProgress = fireNumber > 0 ? Math.max(0, balances.netWorth) / fireNumber : 0;
  const yearsToFireVal = yearsToFire(
    balances.netWorth, avgMonthlySavings + pretaxMonthly, fireNumber, annualGrowthPct
  );

  return {
    netWorth: balances.netWorth,
    cash: balances.cash,
    liquid: balances.liquid,
    retirement: balances.retirement,
    loanDebt: balances.loanDebt,
    avgMonthlyExpenses,
    avgMonthlyIncome,
    avgMonthlySavings,
    pretaxMonthly,
    grossMonthlyIncome,
    savingsRate,
    cashRunwayMonths,
    liquidRunwayMonths,
    fireNumber,
    fireProgress,
    yearsToFire: yearsToFireVal,
  };
}

// ─── Trends ───────────────────────────────────────────────────────────────────

/**
 * Month-by-month spending summary for the last N months.
 * If category is provided, also returns that category's total per month.
 */
export async function getSpendingTrends(months = 12, category?: string): Promise<MonthlyTrendRow[]> {
  // Build list of (year, month) for the last N months
  const now = new Date();
  const periods: { year: number; month: number; from: string; to: string }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year  = d.getFullYear();
    const month = d.getMonth() + 1;
    const from  = `${year}-${String(month).padStart(2, '0')}-01`;
    const to    = `${year}-${String(month).padStart(2, '0')}-31`;
    periods.push({ year, month, from, to });
  }

  return Promise.all(periods.map(async ({ year, month, from, to }) => {
    const result = await db.execute({
      sql: `
        SELECT category, SUM(amount) as total
        FROM transactions
        WHERE date >= ? AND date <= ? AND pending = 0 AND ignored = 0
          AND category NOT IN (SELECT category FROM hidden_categories)
        GROUP BY category
      `,
      args: [from, to],
    });
    const rows = result.rows as unknown as { category: string; total: number }[];

    const income   = rows.filter((r) => Number(r.total) < 0).reduce((s, r) => s + Math.abs(Number(r.total)), 0);
    const expenses = rows.filter((r) => Number(r.total) > 0).reduce((s, r) => s + Number(r.total), 0);

    const row: MonthlyTrendRow = {
      year,
      month,
      label: `${MONTHS[month - 1]} ${year}`,
      income,
      expenses,
      net: income - expenses,
    };

    if (category) {
      const catRow = rows.find((r) => r.category === category);
      row.category = category;
      row.categoryTotal = catRow ? Number(catRow.total) : 0;
    }

    return row;
  }));
}

// ─── App Context ──────────────────────────────────────────────────────────────

/**
 * Structured documentation about the fungible app for the agent's system prompt.
 * Covers data model, sign conventions, screens, and how to interpret data.
 */
export const APP_CONTEXT = `
# fungible — App Reference for Agent

## Data Model
- Transactions are synced from Plaid or imported via CSV.
- **Sign convention**: positive amount = money out (expense); negative amount = money in (income).
- Transactions have: id, date, name, display_name, amount, category, account_id, pending, ignored, manual_category, original_date.
- \`manual_category\`: set when user or agent manually assigns a category. Survives re-syncs.
- \`original_date\`: set when a transaction has been reattributed to a different period (a paycheck
  posting on the 1st that was earned the prior month, a check cashed months after it was written).
  Holds the bank's posting date; \`date\` holds the reattributed one. All totals and trends use
  \`date\`, so they reflect the reattribution. Survives re-syncs.
- \`ignored\`: soft-hides a transaction from all totals (transfers, reimbursements, refunds, etc.).
- \`hidden_categories\`: categories excluded from all totals and charts (e.g. "Transfer").
- Accounts: type is one of depository, investment, credit, other.
- Manual assets are stored as accounts with type='other', subtype='manual'.
- Balances are stored in balance_history (account_id, date, balance). Most recent = current balance.

## Categorization
- Category rules (substring or regex) auto-categorize transactions in priority order.
- Name rules rename the display name without affecting category.
- Both support optional min_amount / max_amount filters.
- A manual category override pins a transaction to a specific category regardless of rules.
- Use uncategorized_summary to see what needs rules written for it.

## Screens
1. Dashboard — spending by category with bar charts; flex view (fixed/flexible/discretionary); account picker
2. Transactions — list with sort, search, date filter, and drill-down from Dashboard
3. Trends — month-by-month bar charts for expenses, income, net, or any category
4. Net Worth — assets, liabilities, net worth, and balance history chart
5. Tags — label transactions across accounts (trips, events, projects)
6. Financial Health — cash/liquid runway, FIRE number and progress, years to retirement
7. Rules — category and name rule management; hidden categories
8. Accounts — connected bank accounts, CSV import, manual assets, dedup review

## Net Worth Calculation
- Assets: depository + investment + other (if balance > 0)
- Liabilities: credit accounts
- Net Worth = Assets − Liabilities

## FIRE Calculation (Financial Health screen)
- FIRE Number = (avg monthly expenses × 12) / withdrawal_rate
- Progress = net_worth / fire_number
- Uses compound growth simulation month-by-month to estimate years to FIRE.
- Defaults: 4% withdrawal rate, 7% annual growth, last-12-months avg for spending and savings.

## Runway
- Cash runway: depository balance / avg monthly expenses
- Liquid runway: (depository + brokerage balance) / avg monthly expenses

## Tags
- Tags label transactions across accounts. A transaction can have multiple tags.
- Use tags for: trips (e.g. "Paris 2025"), projects, events, or any cross-account grouping.
- tag_summary gives income/expenses/net and category breakdown for a tag.
`.trim();
