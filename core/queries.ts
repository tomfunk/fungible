import { db } from './db.js';
import { buildFilterClause, buildFilterConditions, type Filter } from './filters.js';

export type CategorySummary = { category: string; total: number };
export type MonthlySummary  = { income: number; expenses: number; net: number; byCategory: CategorySummary[] };
export type RecentTransaction = { id: string; date: string; name: string; merchant_name: string | null; amount: number; category: string };

export type MerchantSummaryRow = {
  merchant: string;
  total: number;
  count: number;
  pct: number;
};

// The catch-all category. Unlike a real category, it legitimately mixes income
// (e.g. an un-ruled paycheck) with spending, so we never net the two together —
// see summarizeBuckets.
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Turn per-category {outflow, inflow} buckets into an income/expense/byCategory
 * summary. Real categories are NETTED (a refund reduces that category's spending);
 * `Uncategorized` is SPLIT by flow (its outflows are spending, its inflows income)
 * so a paycheck landing there can't erase the uncategorized spending total.
 */
function summarizeBuckets(rows: { category: string; outflow: number; inflow: number }[]): MonthlySummary {
  let income = 0, expenses = 0;
  const byCategory: CategorySummary[] = [];
  for (const r of rows) {
    const outflow = Number(r.outflow), inflow = Number(r.inflow);
    if (r.category === UNCATEGORIZED) {
      if (outflow > 0) { expenses += outflow; byCategory.push({ category: r.category, total: outflow }); }
      income += inflow;
    } else {
      const net = outflow - inflow;
      if (net > 0) { expenses += net; byCategory.push({ category: r.category, total: net }); }
      else income += -net;
    }
  }
  byCategory.sort((a, b) => b.total - a.total);
  return { income, expenses, net: income - expenses, byCategory };
}

/**
 * Trailing-12-month income / expense / savings averages, netted per category by
 * the same rule as summarizeBuckets: a reimbursement sitting inside an expense
 * category reduces that category's spend instead of inflating expenses AND
 * income at once. Summing raw outflows here would overstate avg_expenses, which
 * feeds runway, the FIRE number, and years-to-FIRE.
 *
 * Shared by loadHealthData (TUI/GUI Health tab) and getFinancialHealth (agent),
 * which must not drift apart.
 */
export const TRAILING_12MO_AVERAGES_SQL = `
  SELECT
    COALESCE(SUM(spend), 0) / 12.0            AS avg_expenses,
    COALESCE(SUM(inc), 0) / 12.0              AS avg_income,
    COALESCE(SUM(inc) - SUM(spend), 0) / 12.0 AS avg_savings
  FROM (
    SELECT
      CASE WHEN category = '${UNCATEGORIZED}' THEN outflow
           WHEN outflow > inflow THEN outflow - inflow ELSE 0 END AS spend,
      CASE WHEN category = '${UNCATEGORIZED}' THEN inflow
           WHEN inflow > outflow THEN inflow - outflow ELSE 0 END AS inc
    FROM (
      SELECT category,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)  AS outflow,
        SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS inflow
      FROM transactions
      WHERE date >= date('now', '-12 months')
        AND pending = 0 AND ignored = 0
        AND category NOT IN (SELECT category FROM hidden_categories)
        AND category != 'Transfer'
      GROUP BY category
    )
  )
`;

export async function getHiddenCategories(): Promise<Set<string>> {
  const result = await db.execute('SELECT category FROM hidden_categories');
  return new Set((result.rows as unknown as { category: string }[]).map((r) => r.category));
}

export async function getMonthlySummary(year: number, month: number): Promise<MonthlySummary> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-31`;
  return getRangeSummary(from, to);
}

export async function getRangeSummary(from: string, to: string, filter?: Filter): Promise<MonthlySummary> {
  const f = buildFilterClause(filter, 'transactions');
  const result = await db.execute({
    sql: `SELECT category,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as outflow,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as inflow
          FROM transactions
          WHERE date >= ? AND date <= ? AND pending = 0 AND ignored = 0${f.clause}
            AND category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY category`,
    args: [from, to, ...f.args],
  });
  return summarizeBuckets(result.rows as unknown as { category: string; outflow: number; inflow: number }[]);
}

export async function getTagSummary(tagName: string): Promise<MonthlySummary> {
  const result = await db.execute({
    sql: `SELECT t.category,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as outflow,
            SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) as inflow
          FROM transactions t
          JOIN transaction_tags tt ON tt.transaction_id = t.id
          JOIN tags tg ON tg.id = tt.tag_id
          WHERE tg.name = ? AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY t.category`,
    args: [tagName],
  });
  return summarizeBuckets(result.rows as unknown as { category: string; outflow: number; inflow: number }[]);
}

export async function getMerchantSummary(
  category: string,
  from: string,
  to: string,
  filter?: Filter,
): Promise<MerchantSummaryRow[]> {
  const f = buildFilterClause(filter, 'transactions');

  const result = await db.execute({
    sql: `SELECT COALESCE(display_name, merchant_name, name) as merchant, SUM(amount) as total, COUNT(*) as count
          FROM transactions
          WHERE date >= ? AND date <= ? AND category = ?
            AND pending = 0 AND ignored = 0
            AND category NOT IN (SELECT category FROM hidden_categories)${f.clause}
          GROUP BY merchant
          HAVING SUM(amount) > 0
          ORDER BY total DESC, count DESC, merchant ASC`,
    args: [from, to, category, ...f.args],
  });
  const rows = result.rows as unknown as { merchant: string; total: number; count: number }[];

  // Denominator uses only net-positive merchants — same set as the list. Merchants with more
  // refunds than charges are excluded from both, so pct = share of the positive-net spend shown.
  const categoryTotal = rows.reduce((sum, r) => sum + Number(r.total), 0);
  if (!categoryTotal) return [];

  return rows.map((r) => ({
    merchant: r.merchant,
    total: Number(r.total),
    count: Number(r.count),
    pct: Number(r.total) / categoryTotal,
  }));
}

export type FlexSummary = { fixed: number; flexible: number; discretionary: number; untagged: number };

export async function getFlexSummary(from: string, to: string, filter?: Filter): Promise<FlexSummary> {
  return queryFlexTotals(from, to, filter);
}

export async function getRecentTransactions(limit = 10): Promise<RecentTransaction[]> {
  const result = await db.execute({
    sql: 'SELECT id, date, name, merchant_name, amount, category FROM transactions WHERE pending = 0 ORDER BY date DESC LIMIT ?',
    args: [limit],
  });
  return result.rows as unknown as RecentTransaction[];
}

export async function hasAccounts(): Promise<boolean> {
  const result = await db.execute('SELECT COUNT(*) as count FROM plaid_items');
  return Number((result.rows[0] as unknown as { count: number }).count) > 0;
}

export async function getLastSyncedAt(): Promise<number | null> {
  const res = await db.execute('SELECT MAX(last_synced_at) AS ts FROM plaid_items');
  const row = res.rows[0] as unknown as { ts: number | null };
  return row?.ts ?? null;
}

export async function getUncategorizedCount(from: string, to: string, filter?: Filter): Promise<number> {
  const f = buildFilterClause(filter, 'transactions');
  const result = await db.execute({
    sql: `SELECT COUNT(*) as c FROM transactions
          WHERE category = 'Uncategorized' AND pending = 0 AND ignored = 0
            AND date >= ? AND date <= ?${f.clause}`,
    args: [from, to, ...f.args],
  });
  return Number((result.rows[0] as unknown as { c: number }).c);
}

export async function getDataBounds(): Promise<{ minDate: string; maxDate: string }> {
  const result = await db.execute(
    'SELECT MIN(date) as minDate, MAX(date) as maxDate FROM transactions WHERE pending = 0 AND ignored = 0'
  );
  const row = result.rows[0] as unknown as { minDate: string | null; maxDate: string | null } | undefined;
  return { minDate: row?.minDate ?? '2000-01-01', maxDate: row?.maxDate ?? '2099-12-31' };
}

export type AccountRow = { id: string; name: string; subtype: string | null; spending: number; income: number };

// Per-account spending/income. Honors the shared filter's other dimensions
// (categories/owners/tags) but ignores its own accounts dimension — the view
// groups by account and doubles as the account picker, so every account keeps
// its row. Filter conditions live in the LEFT JOIN ON clause so accounts with
// no matching transactions still appear with zero totals.
export async function getAccountRows(from: string, to: string, filter?: Filter): Promise<AccountRow[]> {
  const f = buildFilterClause({ ...filter, accounts: undefined }, 't');
  const result = await db.execute({
    sql: `SELECT a.id, a.name, a.subtype,
            COALESCE(SUM(CASE WHEN t.amount > 0 AND t.date >= ? AND t.date <= ?
                              AND t.pending = 0 AND t.ignored = 0
                              AND t.category != 'Transfer' THEN t.amount ELSE 0 END), 0) as spending,
            COALESCE(-SUM(CASE WHEN t.amount < 0 AND t.date >= ? AND t.date <= ?
                               AND t.pending = 0 AND t.ignored = 0
                               AND t.category != 'Transfer' THEN t.amount ELSE 0 END), 0) as income
          FROM accounts a
          LEFT JOIN transactions t ON t.account_id = a.id${f.clause}
          GROUP BY a.id, a.name, a.subtype
          ORDER BY CASE a.type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 ELSE 2 END, spending DESC`,
    args: [from, to, from, to, ...f.args],
  });
  return result.rows as unknown as AccountRow[];
}

export type OwnerRow = { owner: string; spending: number };

// Total expenses grouped by account owner, for splitting shared spending. Accounts
// with no owner fall under 'Unassigned'. Uses the same expense definition as the
// dashboard's headline Expenses (getRangeSummary): excludes hidden categories,
// pending, and ignored transactions. Honors the shared filter's other dimensions
// (categories/accounts/tags) but ignores its own owners dimension, since it
// groups by owner. Filters live in the LEFT JOIN ON clause (not WHERE) so every
// owned account still yields a row even with zero spend this period — callers
// rely on that to detect whether any owner has been assigned.
export async function getOwnerRows(from: string, to: string, filter?: Filter): Promise<OwnerRow[]> {
  const f = buildFilterClause({ ...filter, owners: undefined }, 't');
  const result = await db.execute({
    sql: `SELECT COALESCE(NULLIF(TRIM(a.owner), ''), 'Unassigned') as owner,
            COALESCE(SUM(t.amount), 0) as spending
          FROM accounts a
          LEFT JOIN transactions t
            ON t.account_id = a.id
            AND t.amount > 0
            AND t.date >= ? AND t.date <= ?
            AND t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)${f.clause}
          GROUP BY COALESCE(NULLIF(TRIM(a.owner), ''), 'Unassigned')
          ORDER BY spending DESC, owner`,
    args: [from, to, ...f.args],
  });
  return result.rows as unknown as OwnerRow[];
}

// ── Drift ──────────────────────────────────────────────────────────────────────

export type DriftSlice    = {
  current: number; lastPeriodDelta: number; lastYearDelta: number;
  avg12mDelta: number; avg12m: number;
  // Median of the rolling windows — robust to one-off spikes (a single $7K
  // medical month shouldn't inflate the "typical" baseline the way a mean does).
  median12m: number; medianDelta: number;
};
export type CategoryDrift = { category: string } & DriftSlice;
export type FlexDriftData = Record<keyof FlexSummary, DriftSlice>;
export type AccountDrift  = { id: string; name: string; subtype: string | null } & DriftSlice;
type Window = { from: string; to: string };

async function queryCategoryTotals(from: string, to: string, filter?: Filter): Promise<Map<string, number>> {
  const f = buildFilterClause(filter, 'transactions');
  // Per-category spending using the same rule as getRangeSummary (net real
  // categories, split Uncategorized) so delta mode reconciles with the breakdown.
  const result = await db.execute({
    sql: `SELECT category,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as outflow,
            SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as inflow
          FROM transactions
          WHERE date >= ? AND date <= ? AND pending = 0 AND ignored = 0
            AND category NOT IN (SELECT category FROM hidden_categories)${f.clause}
          GROUP BY category`,
    args: [from, to, ...f.args],
  });
  const { byCategory } = summarizeBuckets(result.rows as unknown as { category: string; outflow: number; inflow: number }[]);
  return new Map(byCategory.map((c) => [c.category, c.total]));
}

async function queryFlexTotals(from: string, to: string, filter?: Filter): Promise<FlexSummary> {
  const f = buildFilterClause(filter, 't');
  // Per-category outflow/inflow + its flex tier; spending is netted for real
  // categories and outflow-only for Uncategorized (same rule as summarizeBuckets),
  // then summed into tiers. Uncategorized has no flexibility, so it lands in 'untagged'.
  const result = await db.execute({
    sql: `SELECT t.category, COALESCE(c.flexibility, 'untagged') as tier,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as outflow,
            SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) as inflow
          FROM transactions t
          LEFT JOIN categories c ON c.name = t.category
          WHERE t.date >= ? AND t.date <= ?
            AND t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)${f.clause}
          GROUP BY t.category, c.flexibility`,
    args: [from, to, ...f.args],
  });
  const rows = result.rows as unknown as { category: string; tier: string; outflow: number; inflow: number }[];
  const out: FlexSummary = { fixed: 0, flexible: 0, discretionary: 0, untagged: 0 };
  for (const r of rows) {
    const outflow = Number(r.outflow), inflow = Number(r.inflow);
    const spend = r.category === UNCATEGORIZED ? outflow : outflow - inflow;
    if (spend <= 0) continue;
    const tier = r.tier as keyof FlexSummary;
    if (tier in out) out[tier] += spend;
  }
  return out;
}

async function queryAccountSpending(from: string, to: string): Promise<Map<string, number>> {
  const result = await db.execute({
    sql: `SELECT a.id,
            COALESCE(SUM(CASE WHEN t.amount > 0 AND t.category != 'Transfer'
                              AND t.pending = 0 AND t.ignored = 0 THEN t.amount ELSE 0 END), 0) as spending
          FROM accounts a
          LEFT JOIN transactions t ON t.account_id = a.id
            AND t.date >= ? AND t.date <= ?
          GROUP BY a.id`,
    args: [from, to],
  });
  const rows = result.rows as unknown as { id: string; spending: number }[];
  return new Map(rows.map((r) => [r.id, Number(r.spending)]));
}

function sliceFor(current: number, last: number, year: number, rolling: number[]): DriftSlice {
  const avg12m = rolling.length > 0 ? rolling.reduce((s, v) => s + v, 0) / rolling.length : 0;
  let median12m = 0;
  if (rolling.length > 0) {
    const sorted = [...rolling].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median12m = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return {
    current, lastPeriodDelta: current - last, lastYearDelta: current - year,
    avg12mDelta: current - avg12m, avg12m,
    median12m, medianDelta: current - median12m,
  };
}

// Rolling windows from before the first transaction contribute phantom zeros
// that drag baselines down (e.g. 3 months of history averaged over 12 windows).
async function clampToHistory(windows: Window[]): Promise<Window[]> {
  const { minDate } = await getDataBounds();
  return windows.filter((w) => w.to >= minDate);
}

export async function getCategoryDriftData(
  currentWin: Window, lastPeriodWin: Window, lastYearWin: Window, rolling12: Window[], filter?: Filter,
): Promise<CategoryDrift[]> {
  const rolling = await clampToHistory(rolling12);
  const [cur, last, yr, ...rolls] = await Promise.all([
    queryCategoryTotals(currentWin.from, currentWin.to, filter),
    queryCategoryTotals(lastPeriodWin.from, lastPeriodWin.to, filter),
    queryCategoryTotals(lastYearWin.from, lastYearWin.to, filter),
    ...rolling.map((w) => queryCategoryTotals(w.from, w.to, filter)),
  ]);
  return [...cur.entries()]
    .map(([category, currentAmt]) => ({
      category,
      ...sliceFor(currentAmt, last.get(category) ?? 0, yr.get(category) ?? 0, rolls.map((m) => m.get(category) ?? 0)),
    }))
    .sort((a, b) => b.current - a.current);
}

export async function getFlexDriftData(
  currentWin: Window, lastPeriodWin: Window, lastYearWin: Window, rolling12: Window[], filter?: Filter,
): Promise<FlexDriftData> {
  const rolling = await clampToHistory(rolling12);
  const [cur, last, yr, ...rolls] = await Promise.all([
    queryFlexTotals(currentWin.from, currentWin.to, filter),
    queryFlexTotals(lastPeriodWin.from, lastPeriodWin.to, filter),
    queryFlexTotals(lastYearWin.from, lastYearWin.to, filter),
    ...rolling.map((w) => queryFlexTotals(w.from, w.to, filter)),
  ]);
  const tiers: (keyof FlexSummary)[] = ['fixed', 'flexible', 'discretionary', 'untagged'];
  return Object.fromEntries(
    tiers.map((tier) => [tier, sliceFor(cur[tier], last[tier], yr[tier], rolls.map((r) => r[tier]))]),
  ) as FlexDriftData;
}

export async function getAccountDriftData(
  currentWin: Window, lastPeriodWin: Window, lastYearWin: Window, rolling12: Window[],
): Promise<AccountDrift[]> {
  const acctRes = await db.execute(
    `SELECT id, name, subtype FROM accounts
     ORDER BY CASE type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 ELSE 2 END, name`
  );
  const accounts = acctRes.rows as unknown as { id: string; name: string; subtype: string | null }[];

  const rolling = await clampToHistory(rolling12);
  const [cur, last, yr, ...rolls] = await Promise.all([
    queryAccountSpending(currentWin.from, currentWin.to),
    queryAccountSpending(lastPeriodWin.from, lastPeriodWin.to),
    queryAccountSpending(lastYearWin.from, lastYearWin.to),
    ...rolling.map((w) => queryAccountSpending(w.from, w.to)),
  ]);

  return accounts.map((acct) => ({
    ...acct,
    ...sliceFor(cur.get(acct.id) ?? 0, last.get(acct.id) ?? 0, yr.get(acct.id) ?? 0, rolls.map((m) => m.get(acct.id) ?? 0)),
  }));
}

export async function getSearchFilteredData(
  from: string, to: string, search: string, filter?: Filter,
): Promise<{ summary: MonthlySummary; flexData: FlexSummary }> {
  const f = buildFilterClause(filter, 't');
  const result = await db.execute({
    sql: `SELECT COALESCE(t.display_name, t.merchant_name, t.name) as display, t.amount, t.category,
            COALESCE(c.flexibility, 'untagged') as flex
          FROM transactions t
          LEFT JOIN categories c ON c.name = t.category
          WHERE t.date >= ? AND t.date <= ?
            AND t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)${f.clause}`,
    args: [from, to, ...f.args],
  });
  const rows = result.rows as unknown as { display: string; amount: number; category: string; flex: string }[];

  const re = buildSearchRe(search);
  const matches = rows.filter((r) => re.test(r.display));

  // Accumulate per-category outflow/inflow, then apply the hybrid rule: real
  // categories net (refunds reduce them), Uncategorized splits by flow (outflow =
  // spending, inflow = income). Mirrors summarizeBuckets / queryFlexTotals.
  const catMap = new Map<string, { outflow: number; inflow: number; flex: string }>();
  for (const r of matches) {
    const amt = Number(r.amount);
    const e = catMap.get(r.category) ?? { outflow: 0, inflow: 0, flex: r.flex };
    if (amt > 0) e.outflow += amt;
    else if (amt < 0) e.inflow += -amt;
    catMap.set(r.category, e);
  }

  let income = 0, expenses = 0;
  const byCategory: { category: string; total: number }[] = [];
  const flexData: FlexSummary = { fixed: 0, flexible: 0, discretionary: 0, untagged: 0 };
  for (const [category, { outflow, inflow, flex }] of catMap) {
    let spend: number;
    if (category === UNCATEGORIZED) { spend = outflow; income += inflow; }
    else {
      const net = outflow - inflow;
      if (net < 0) { income += -net; continue; }
      spend = net;
    }
    if (spend <= 0) continue;
    expenses += spend;
    byCategory.push({ category, total: spend });
    if (flex === 'fixed') flexData.fixed += spend;
    else if (flex === 'flexible') flexData.flexible += spend;
    else if (flex === 'discretionary') flexData.discretionary += spend;
    else flexData.untagged += spend;
  }

  byCategory.sort((a, b) => b.total - a.total);
  return { summary: { income, expenses, net: income - expenses, byCategory }, flexData };
}

export type Rule = { id: number; priority: number; match_type: string; pattern: string; category: string; min_amount: number | null; max_amount: number | null; account_id: string | null };
export type NameRule = { id: number; match_type: string; pattern: string; replacement: string; min_amount: number | null; max_amount: number | null; account_id: string | null };
export type TagRuleRow = { id: number; priority: number; match_type: string; pattern: string; tag_id: number; tag_name: string; min_amount: number | null; max_amount: number | null; account_id: string | null };
export type CategoryDetail = { name: string; flexibility: 'fixed' | 'flexible' | 'discretionary' | null };

export async function getAllRules(): Promise<Rule[]> {
  const result = await db.execute('SELECT id, priority, match_type, pattern, category, min_amount, max_amount, account_id FROM category_rules ORDER BY priority DESC, (account_id IS NULL) ASC, id ASC');
  return result.rows as unknown as Rule[];
}

export async function getAllNameRules(): Promise<NameRule[]> {
  const result = await db.execute('SELECT id, match_type, pattern, replacement, min_amount, max_amount, account_id FROM name_rules ORDER BY (account_id IS NULL) ASC, id ASC');
  return result.rows as unknown as NameRule[];
}

export async function getAllTagRules(): Promise<TagRuleRow[]> {
  const result = await db.execute(
    `SELECT tr.id, tr.priority, tr.match_type, tr.pattern, tr.tag_id, t.name AS tag_name,
            tr.min_amount, tr.max_amount, tr.account_id
     FROM tag_rules tr JOIN tags t ON t.id = tr.tag_id
     ORDER BY tr.priority DESC, (tr.account_id IS NULL) ASC, tr.id ASC`
  );
  return result.rows as unknown as TagRuleRow[];
}

export async function getAllCategories(): Promise<string[]> {
  const result = await db.execute('SELECT name FROM categories ORDER BY name');
  return (result.rows as unknown as { name: string }[]).map((r) => r.name);
}

// Option universes for the shared filter panel: every category, account
// (id/name/owner), distinct owner bucket ('Unassigned' for accounts with no
// owner), and tag name. The panel selects from these and serializes a Filter.
export type FilterOptionAccount = { id: string; name: string; owner: string };
export type FilterOptions = {
  categories: string[];
  accounts: FilterOptionAccount[];
  owners: string[];
  tags: string[];
};

export async function getFilterOptions(): Promise<FilterOptions> {
  const [cats, accts, tags] = await Promise.all([
    db.execute('SELECT name FROM categories ORDER BY name'),
    db.execute(
      `SELECT id, name, COALESCE(NULLIF(TRIM(owner), ''), 'Unassigned') as owner
       FROM accounts ORDER BY name`,
    ),
    db.execute('SELECT name FROM tags ORDER BY name'),
  ]);
  const accounts = (accts.rows as unknown as FilterOptionAccount[]).map((r) => ({
    id: r.id, name: r.name, owner: r.owner,
  }));
  const owners = [...new Set(accounts.map((a) => a.owner))].sort();
  return {
    categories: (cats.rows as unknown as { name: string }[]).map((r) => r.name),
    accounts,
    owners,
    tags: (tags.rows as unknown as { name: string }[]).map((r) => r.name),
  };
}

export async function getCategoryDetails(): Promise<CategoryDetail[]> {
  const result = await db.execute('SELECT name, flexibility FROM categories ORDER BY name');
  return result.rows as unknown as CategoryDetail[];
}

export async function getHiddenCategorySet(): Promise<Set<string>> {
  const result = await db.execute('SELECT category FROM hidden_categories');
  return new Set((result.rows as unknown as { category: string }[]).map((r) => r.category));
}

export async function toggleHiddenCategory(category: string, hidden: Set<string>): Promise<void> {
  if (hidden.has(category)) {
    await db.execute({ sql: 'DELETE FROM hidden_categories WHERE category = ?', args: [category] });
  } else {
    await db.execute({ sql: 'INSERT OR IGNORE INTO hidden_categories (category) VALUES (?)', args: [category] });
  }
}

export type Tag = {
  id: number; name: string; count: number; inflow: number; outflow: number;
  earliest: string | null; latest: string | null;
};

export async function getAllTags(): Promise<Tag[]> {
  const result = await db.execute(`
    SELECT t.id, t.name, COUNT(tt.transaction_id) as count,
      COALESCE(SUM(CASE WHEN tx.amount < 0 THEN ABS(tx.amount) ELSE 0 END), 0) as inflow,
      COALESCE(SUM(CASE WHEN tx.amount > 0 THEN tx.amount ELSE 0 END), 0) as outflow,
      MIN(tx.date) as earliest, MAX(tx.date) as latest
    FROM tags t
    LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
    LEFT JOIN transactions tx ON tx.id = tt.transaction_id
    GROUP BY t.id ORDER BY t.name
  `);
  return (result.rows as unknown as Tag[]).map((r) => ({
    id: Number(r.id), name: r.name, count: Number(r.count), inflow: Number(r.inflow), outflow: Number(r.outflow),
    earliest: r.earliest, latest: r.latest,
  }));
}

export type SortMode = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'name-asc' | 'name-desc' | 'category-asc' | 'category-desc';
export const SORT_ORDER_BY: Record<SortMode, string> = {
  'date-desc':     't.date DESC, t.id DESC',
  'date-asc':      't.date ASC, t.id ASC',
  'amount-desc':   't.amount DESC',
  'amount-asc':    't.amount ASC',
  'name-asc':      'COALESCE(t.display_name, t.merchant_name, t.name) ASC',
  'name-desc':     'COALESCE(t.display_name, t.merchant_name, t.name) DESC',
  'category-asc':  't.category ASC, t.date DESC',
  'category-desc': 't.category DESC, t.date DESC',
};

export type TxRow = {
  id: string; date: string; name: string; display_name: string | null; merchant_name: string | null;
  amount: number; category: string; manual_category: string | null; ignored: number; tag_names: string | null;
};

export function buildSearchRe(search: string): RegExp {
  try { return new RegExp(search, 'i'); }
  catch { return new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

export async function getTransactions(filters: {
  filter?: Filter; from?: string | null; to?: string | null;
  search?: string; sort?: SortMode;
  txType?: 'income' | 'expenses' | null;
  flex?: 'fixed' | 'flexible' | 'discretionary' | null;
}): Promise<TxRow[]> {
  const { filter, from, to, search, sort = 'date-desc', txType, flex } = filters;
  const conditions: string[] = [];
  const args: (string | number | null)[] = [];

  if (from && to) { conditions.push('t.date >= ? AND t.date <= ?'); args.push(from, to); }
  const fc = buildFilterConditions(filter, 't');
  conditions.push(...fc.conditions);
  args.push(...fc.args);
  if (txType === 'income') { conditions.push('t.amount < 0'); conditions.push('t.category NOT IN (SELECT category FROM hidden_categories)'); }
  if (txType === 'expenses') { conditions.push('t.amount > 0'); conditions.push('t.category NOT IN (SELECT category FROM hidden_categories)'); }
  if (flex) { conditions.push('EXISTS (SELECT 1 FROM categories c WHERE c.name = t.category AND c.flexibility = ?)'); args.push(flex); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const result = await db.execute({
    sql: `SELECT t.id, t.date, t.name, t.display_name, t.merchant_name, t.amount, t.category, t.manual_category, t.ignored,
            (SELECT GROUP_CONCAT(tg2.name, ', ') FROM transaction_tags tt2 JOIN tags tg2 ON tg2.id = tt2.tag_id WHERE tt2.transaction_id = t.id) as tag_names
          FROM transactions t ${where}
          ORDER BY ${SORT_ORDER_BY[sort]}
          LIMIT 5000`,
    args,
  });
  const rows = result.rows as unknown as TxRow[];
  if (!search) return rows.slice(0, 200);
  const re = buildSearchRe(search);
  return rows.filter((r) =>
    re.test(r.display_name ?? r.merchant_name ?? r.name) ||
    (!r.display_name && r.merchant_name !== null && re.test(r.name)),
  ).slice(0, 200);
}

export async function countSearchMatches(
  from: string, to: string, search: string, filter?: Filter,
): Promise<{ count: number; expenses: number }> {
  if (!search) return { count: 0, expenses: 0 };
  const f = buildFilterClause(filter, 'transactions');
  const result = await db.execute({
    sql: `SELECT COALESCE(display_name, merchant_name, name) as display, amount
          FROM transactions WHERE date >= ? AND date <= ?${f.clause} AND pending = 0 AND ignored = 0`,
    args: [from, to, ...f.args],
  });
  const rows = result.rows as unknown as { display: string; amount: number }[];
  const re = buildSearchRe(search);
  const matches = rows.filter((r) => re.test(r.display));
  return { count: matches.length, expenses: matches.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0) };
}

export type LinkedAccount = {
  id: string; name: string; nickname: string | null; owner: string | null; type: string;
  subtype: string | null; institution_name: string | null; mask: string | null; item_id: string | null;
  // MAX(balance_history.date) — when this account's balance was last snapshotted.
  // The only sync signal a manual/CSV account has, since those have no Plaid item.
  last_synced: string | null;
  apr: number | null; excluded: boolean;
  // A freshly linked Plaid item with no accounts rows yet: it exists in plaid_items
  // but its first sync hasn't run, so there is nothing real to render. Named
  // awaitingFirstSync, not `pending` — `pending` means "Plaid pending transaction"
  // everywhere else in this file.
  awaitingFirstSync: boolean;
  // plaid_items.last_synced_at (epoch ms) — when we last successfully talked to
  // this institution. NULL for CSV/manual accounts, which have no item.
  item_last_synced_at: number | null;
};

export async function getLinkedAccounts(): Promise<LinkedAccount[]> {
  // Two queries rather than a UNION ALL: the shapes barely overlap and this
  // function already maps rows, so concatenating in TS reads clearer.
  const [result, bare] = await Promise.all([
    db.execute(`
      SELECT a.id, a.name, a.nickname, a.owner, a.type, a.subtype, a.mask, a.item_id, a.apr, a.excluded,
        -- accounts.institution_name is only ever written by CSV import and the
        -- demo seeder; the Plaid path records the name on plaid_items and never
        -- copies it down, leaving every linked account's institution blank.
        -- Reading through the join fixes that for existing rows with no
        -- migration and no backfill, and CSV/manual accounts (no item) keep
        -- their own value.
        COALESCE(a.institution_name, pi.institution_name) as institution_name,
        (SELECT MAX(date) FROM balance_history WHERE account_id = a.id) as last_synced,
        pi.last_synced_at as item_last_synced_at
      FROM accounts a
      LEFT JOIN plaid_items pi ON pi.item_id = a.item_id
      ORDER BY CASE a.type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 WHEN 'credit' THEN 2 ELSE 3 END, a.name
    `),
    // Items that have never completed a sync AND have no visible row. Both
    // clauses are load-bearing:
    //   last_synced_at IS NULL — written last in syncTransactions, so it means
    //     "no sync ever finished". Without it, an item whose sync succeeded but
    //     whose accountsGet returned zero accounts would read "awaiting first
    //     sync" forever, and deleteAccount (which leaves plaid_items behind)
    //     would resurrect a deleted item as a placeholder.
    //   NOT EXISTS — self-clears the moment the first accountsGet upsert lands,
    //     so no cleanup path is needed. It also keeps real rows from being
    //     duplicated when accountsGet succeeded but the transaction upsert threw.
    db.execute(`
      SELECT pi.item_id, pi.institution_name
      FROM plaid_items pi
      WHERE pi.last_synced_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.item_id = pi.item_id)
      ORDER BY pi.institution_name
    `),
  ]);

  const accounts = (result.rows as unknown as (Omit<LinkedAccount, 'excluded' | 'awaitingFirstSync' | 'item_last_synced_at'> & { excluded: number; item_last_synced_at: number | null })[]).map((r) => ({
    ...r,
    excluded: toBool(r.excluded),
    item_last_synced_at: r.item_last_synced_at === null ? null : Number(r.item_last_synced_at),
    awaitingFirstSync: false,
  }));

  // Placeholders sort first — there are at most one or two and their whole
  // purpose is to be noticed right after a link.
  const placeholders: LinkedAccount[] = (bare.rows as unknown as { item_id: string; institution_name: string | null }[])
    .map((r) => ({
      id: r.item_id,   // distinct namespace from Plaid account_id; safe as a React key
      name: r.institution_name ?? 'New institution',
      nickname: null,
      owner: null,
      type: 'other',
      subtype: null,
      institution_name: r.institution_name,
      mask: null,
      item_id: r.item_id,
      last_synced: null,
      apr: null,
      excluded: false,
      awaitingFirstSync: true,
      item_last_synced_at: null,
    }));

  return [...placeholders, ...accounts];
}

/**
 * One row per Plaid connection, for the Links view.
 *
 * Deliberately item-shaped rather than account-shaped: the things this view
 * exists to manage — the sync cursor, the history window, updating credentials,
 * replacing a connection — are all properties of the item, not of the accounts
 * hanging off it. getLinkedAccounts answers a different question and flattens
 * the item away.
 */
export type LinkedItem = {
  item_id: string;
  institution_name: string | null;
  // Epoch ms of the last sync that ran to completion, written last in
  // syncTransactions. NULL means no sync has ever finished for this item.
  last_synced_at: number | null;
  // Locked in at link time and unchangeable afterwards — Plaid rejects a wider
  // window on an item that already has Transactions. NULL predates the column,
  // in which case Plaid's 90-day default applied.
  days_requested: number | null;
  account_count: number;
  // Linked, but the first sync has not landed. Same two-clause rule as
  // getLinkedAccounts uses for its placeholder rows, and load-bearing for the
  // same reasons: last_synced_at alone would mislabel an item whose sync
  // succeeded but returned no accounts, and the count alone would resurrect an
  // item whose accounts were deleted (deleteAccount leaves plaid_items behind).
  awaitingFirstSync: boolean;
  // Whether a /transactions/sync cursor is stored. No cursor means the next
  // sync replays the item's full history from the start.
  hasCursor: boolean;
};

export async function getLinkedItems(): Promise<LinkedItem[]> {
  const result = await db.execute(`
    SELECT pi.item_id, pi.institution_name, pi.last_synced_at, pi.days_requested,
           (SELECT COUNT(*) FROM accounts a WHERE a.item_id = pi.item_id) as account_count,
           (SELECT COUNT(*) FROM sync_state s WHERE s.account_id = pi.item_id) as cursor_count
    FROM plaid_items pi
    ORDER BY pi.institution_name, pi.item_id
  `);
  return (result.rows as unknown as {
    item_id: string; institution_name: string | null; last_synced_at: number | null;
    days_requested: number | null; account_count: number; cursor_count: number;
  }[]).map((r) => ({
    item_id: r.item_id,
    institution_name: r.institution_name,
    last_synced_at: r.last_synced_at === null ? null : Number(r.last_synced_at),
    days_requested: r.days_requested === null ? null : Number(r.days_requested),
    account_count: Number(r.account_count),
    awaitingFirstSync: r.last_synced_at === null && Number(r.account_count) === 0,
    hasCursor: Number(r.cursor_count) > 0,
  }));
}

export type CsvAccount = { id: string; name: string; mask: string | null };

export async function getCsvAccounts(): Promise<CsvAccount[]> {
  const result = await db.execute('SELECT id, name, mask FROM accounts');
  return result.rows as unknown as CsvAccount[];
}

export type AccountBalance    = { id: string; name: string; nickname: string | null; type: string; subtype: string | null; balance: number; excluded: boolean };

// SQLite has no boolean type — integer 0/1 columns are coerced here.
const toBool = (v: unknown): boolean => Number(v) === 1;
export type HistoryRow        = { date: string; assets: number; liabilities: number; net: number };
export type NetWorthPeriod    = { period: string; assets: number; liabilities: number; net_worth: number };
export type NetWorthGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

export async function getNetWorthHistory(granularity: NetWorthGranularity = 'month', accountIds?: string[]): Promise<NetWorthPeriod[]> {
  if (accountIds !== undefined && accountIds.length === 0) return [];
  const periodExpr: Record<NetWorthGranularity, string> = {
    day:     `strftime('%Y-%m-%d', date)`,
    week:    `strftime('%Y-W%W', date)`,
    month:   `strftime('%Y-%m', date)`,
    quarter: `strftime('%Y', date) || '-Q' || ((CAST(strftime('%m', date) AS INTEGER) + 2) / 3)`,
    year:    `strftime('%Y', date)`,
  };
  const expr = periodExpr[granularity];
  const filterArgs = accountIds ?? [];
  const filterClause = filterArgs.length > 0
    ? ` AND a.id IN (${filterArgs.map(() => '?').join(',')})`
    : '';
  const result = await db.execute({
    sql: `
    WITH period_last AS (
      SELECT
        ${expr} AS period,
        account_id,
        balance,
        ROW_NUMBER() OVER (PARTITION BY ${expr}, account_id ORDER BY date DESC) AS rn
      FROM balance_history
    )
    SELECT
      pl.period,
      SUM(CASE
        WHEN a.type IN ('depository', 'investment') THEN pl.balance
        WHEN a.type = 'other' AND pl.balance > 0 THEN pl.balance
        ELSE 0
      END) AS assets,
      SUM(CASE WHEN a.type = 'credit' THEN pl.balance ELSE 0 END) AS liabilities,
      SUM(CASE
        WHEN a.type IN ('depository', 'investment') THEN pl.balance
        WHEN a.type = 'other' AND pl.balance > 0 THEN pl.balance
        WHEN a.type = 'credit' THEN -pl.balance
        ELSE 0
      END) AS net_worth
    FROM period_last pl
    JOIN accounts a ON a.id = pl.account_id
    WHERE pl.rn = 1 AND a.excluded = 0${filterClause}
    GROUP BY pl.period
    ORDER BY pl.period ASC
  `,
    args: filterArgs,
  });
  return (result.rows as unknown as { period: string; assets: number; liabilities: number; net_worth: number }[]).map((r) => ({
    period:      r.period,
    assets:      Number(r.assets),
    liabilities: Number(r.liabilities),
    net_worth:   Number(r.net_worth),
  }));
}

export async function getAccountsWithBalances(): Promise<{ accounts: AccountBalance[]; history: HistoryRow[] }> {
  const [acctResult, histResult] = await Promise.all([
    db.execute(`
      SELECT a.id, a.name, a.nickname, a.type, a.subtype, a.excluded, bh.balance
      FROM accounts a
      JOIN balance_history bh ON bh.account_id = a.id
      WHERE bh.date = (SELECT MAX(date) FROM balance_history WHERE account_id = a.id)
      ORDER BY CASE a.type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 ELSE 2 END, bh.balance DESC
    `),
    db.execute(`
      SELECT bh.date,
        SUM(CASE WHEN a.type IN ('depository','investment') OR (a.type = 'other' AND bh.balance > 0) THEN bh.balance ELSE 0 END) as assets,
        SUM(CASE WHEN a.type = 'credit' THEN bh.balance ELSE 0 END) as liabilities
      FROM balance_history bh
      JOIN accounts a ON a.id = bh.account_id
      WHERE a.excluded = 0
      GROUP BY bh.date ORDER BY bh.date
    `),
  ]);
  const accounts = (acctResult.rows as unknown as (Omit<AccountBalance, 'excluded'> & { excluded: number })[]).map((r) => ({
    ...r, excluded: toBool(r.excluded),
  }));
  const history = (histResult.rows as unknown as { date: string; assets: number; liabilities: number }[]).map((r) => ({
    ...r, assets: Number(r.assets), liabilities: Number(r.liabilities), net: Number(r.assets) - Number(r.liabilities),
  }));
  return { accounts, history };
}
