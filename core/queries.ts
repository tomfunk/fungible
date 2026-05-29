import { db } from './db.js';

export type CategorySummary = { category: string; total: number };
export type MonthlySummary  = { income: number; expenses: number; net: number; byCategory: CategorySummary[] };
export type RecentTransaction = { id: string; date: string; name: string; merchant_name: string | null; amount: number; category: string };

export async function getHiddenCategories(): Promise<Set<string>> {
  const result = await db.execute('SELECT category FROM hidden_categories');
  return new Set((result.rows as unknown as { category: string }[]).map((r) => r.category));
}

export async function getMonthlySummary(year: number, month: number): Promise<MonthlySummary> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-31`;
  return getRangeSummary(from, to);
}

export async function getRangeSummary(from: string, to: string, accountId?: string): Promise<MonthlySummary> {
  const acctClause = accountId ? 'AND account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT category, SUM(amount) as total
          FROM transactions
          WHERE date >= ? AND date <= ? AND pending = 0 AND ignored = 0 ${acctClause}
            AND category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY category ORDER BY total DESC`,
    args,
  });
  const rows = result.rows as unknown as { category: string; total: number }[];
  const income   = rows.filter((r) => r.total < 0).reduce((s, r) => s + Math.abs(r.total), 0);
  const expenses = rows.filter((r) => r.total > 0).reduce((s, r) => s + r.total, 0);
  const byCategory = rows.filter((r) => r.total > 0).map((r) => ({ category: r.category, total: Number(r.total) }));
  return { income, expenses, net: income - expenses, byCategory };
}

export async function getTagSummary(tagName: string): Promise<MonthlySummary> {
  const result = await db.execute({
    sql: `SELECT t.category, SUM(t.amount) as total
          FROM transactions t
          JOIN transaction_tags tt ON tt.transaction_id = t.id
          JOIN tags tg ON tg.id = tt.tag_id
          WHERE tg.name = ? AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY t.category ORDER BY total DESC`,
    args: [tagName],
  });
  const rows = result.rows as unknown as { category: string; total: number }[];
  const income     = rows.filter((r) => r.total < 0).reduce((s, r) => s + Math.abs(r.total), 0);
  const expenses   = rows.filter((r) => r.total > 0).reduce((s, r) => s + r.total, 0);
  const byCategory = rows.filter((r) => r.total > 0).map((r) => ({ category: r.category, total: Number(r.total) }));
  return { income, expenses, net: income - expenses, byCategory };
}

export type FlexSummary = { fixed: number; flexible: number; discretionary: number; untagged: number };

export async function getFlexSummary(from: string, to: string, accountId?: string): Promise<FlexSummary> {
  return queryFlexTotals(from, to, accountId);
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

export async function getUncategorizedCount(from: string, to: string, accountId?: string): Promise<number> {
  const where = accountId ? 'AND account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT COUNT(*) as c FROM transactions
          WHERE category = 'Uncategorized' AND pending = 0 AND ignored = 0
            AND date >= ? AND date <= ? ${where}`,
    args,
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

export async function getAccountRows(from: string, to: string): Promise<AccountRow[]> {
  const result = await db.execute({
    sql: `SELECT a.id, a.name, a.subtype,
            COALESCE(SUM(CASE WHEN t.amount > 0 AND t.date >= ? AND t.date <= ?
                              AND t.pending = 0 AND t.ignored = 0
                              AND t.category != 'Transfer' THEN t.amount ELSE 0 END), 0) as spending,
            COALESCE(-SUM(CASE WHEN t.amount < 0 AND t.date >= ? AND t.date <= ?
                               AND t.pending = 0 AND t.ignored = 0
                               AND t.category != 'Transfer' THEN t.amount ELSE 0 END), 0) as income
          FROM accounts a
          LEFT JOIN transactions t ON t.account_id = a.id
          GROUP BY a.id, a.name, a.subtype
          ORDER BY CASE a.type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 ELSE 2 END, spending DESC`,
    args: [from, to, from, to],
  });
  return result.rows as unknown as AccountRow[];
}

// ── Drift ──────────────────────────────────────────────────────────────────────

export type DriftSlice    = { current: number; lastPeriodDelta: number; lastYearDelta: number; avg12mDelta: number; avg12m: number };
export type CategoryDrift = { category: string } & DriftSlice;
export type FlexDriftData = Record<keyof FlexSummary, DriftSlice>;
export type AccountDrift  = { id: string; name: string; subtype: string | null } & DriftSlice;
type Window = { from: string; to: string };

async function queryCategoryTotals(from: string, to: string, accountId?: string): Promise<Map<string, number>> {
  const acctClause = accountId ? 'AND account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT category, SUM(amount) as total
          FROM transactions
          WHERE date >= ? AND date <= ? ${acctClause}
            AND amount > 0 AND pending = 0 AND ignored = 0
            AND category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY category HAVING SUM(amount) > 0`,
    args,
  });
  const rows = result.rows as unknown as { category: string; total: number }[];
  return new Map(rows.map((r) => [r.category, Number(r.total)]));
}

async function queryFlexTotals(from: string, to: string, accountId?: string): Promise<FlexSummary> {
  const acctClause = accountId ? 'AND t.account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT COALESCE(c.flexibility, 'untagged') as tier, SUM(cat_totals.total) as total
          FROM (
            SELECT t.category, SUM(t.amount) as total
            FROM transactions t
            WHERE t.date >= ? AND t.date <= ? ${acctClause}
              AND t.pending = 0 AND t.ignored = 0
              AND t.category NOT IN (SELECT category FROM hidden_categories)
            GROUP BY t.category HAVING SUM(t.amount) > 0
          ) as cat_totals
          LEFT JOIN categories c ON c.name = cat_totals.category
          GROUP BY tier`,
    args,
  });
  const rows = result.rows as unknown as { tier: string; total: number }[];
  const out: FlexSummary = { fixed: 0, flexible: 0, discretionary: 0, untagged: 0 };
  for (const r of rows) {
    const t = r.tier as keyof FlexSummary;
    if (t in out) out[t] = Number(r.total);
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
  return { current, lastPeriodDelta: current - last, lastYearDelta: current - year, avg12mDelta: current - avg12m, avg12m };
}

export async function getCategoryDriftData(
  currentWin: Window, lastPeriodWin: Window, lastYearWin: Window, rolling12: Window[], accountId?: string,
): Promise<CategoryDrift[]> {
  const [cur, last, yr, ...rolls] = await Promise.all([
    queryCategoryTotals(currentWin.from, currentWin.to, accountId),
    queryCategoryTotals(lastPeriodWin.from, lastPeriodWin.to, accountId),
    queryCategoryTotals(lastYearWin.from, lastYearWin.to, accountId),
    ...rolling12.map((w) => queryCategoryTotals(w.from, w.to, accountId)),
  ]);
  return [...cur.entries()]
    .map(([category, currentAmt]) => ({
      category,
      ...sliceFor(currentAmt, last.get(category) ?? 0, yr.get(category) ?? 0, rolls.map((m) => m.get(category) ?? 0)),
    }))
    .sort((a, b) => b.current - a.current);
}

export async function getFlexDriftData(
  currentWin: Window, lastPeriodWin: Window, lastYearWin: Window, rolling12: Window[], accountId?: string,
): Promise<FlexDriftData> {
  const [cur, last, yr, ...rolls] = await Promise.all([
    queryFlexTotals(currentWin.from, currentWin.to, accountId),
    queryFlexTotals(lastPeriodWin.from, lastPeriodWin.to, accountId),
    queryFlexTotals(lastYearWin.from, lastYearWin.to, accountId),
    ...rolling12.map((w) => queryFlexTotals(w.from, w.to, accountId)),
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

  const [cur, last, yr, ...rolls] = await Promise.all([
    queryAccountSpending(currentWin.from, currentWin.to),
    queryAccountSpending(lastPeriodWin.from, lastPeriodWin.to),
    queryAccountSpending(lastYearWin.from, lastYearWin.to),
    ...rolling12.map((w) => queryAccountSpending(w.from, w.to)),
  ]);

  return accounts.map((acct) => ({
    ...acct,
    ...sliceFor(cur.get(acct.id) ?? 0, last.get(acct.id) ?? 0, yr.get(acct.id) ?? 0, rolls.map((m) => m.get(acct.id) ?? 0)),
  }));
}

export async function getSearchFilteredData(
  from: string, to: string, search: string, accountId?: string,
): Promise<{ summary: MonthlySummary; flexData: FlexSummary }> {
  const acctClause = accountId ? 'AND t.account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT COALESCE(t.display_name, t.name) as display, t.merchant_name, t.amount, t.category,
            COALESCE(c.flexibility, 'untagged') as flex
          FROM transactions t
          LEFT JOIN categories c ON c.name = t.category
          WHERE t.date >= ? AND t.date <= ? ${acctClause}
            AND t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)`,
    args,
  });
  const rows = result.rows as unknown as { display: string; merchant_name: string | null; amount: number; category: string; flex: string }[];

  const re = buildSearchRe(search);
  const matches = rows.filter((r) => re.test(r.display) || (r.merchant_name ? re.test(r.merchant_name) : false));

  const catMap = new Map<string, { total: number; flex: string }>();
  for (const r of matches) {
    const e = catMap.get(r.category);
    if (!e) catMap.set(r.category, { total: Number(r.amount), flex: r.flex });
    else e.total += Number(r.amount);
  }

  let income = 0, expenses = 0;
  const byCategory: { category: string; total: number }[] = [];
  const flexData: FlexSummary = { fixed: 0, flexible: 0, discretionary: 0, untagged: 0 };

  for (const [category, { total, flex }] of catMap) {
    if (total < 0) { income += Math.abs(total); }
    else if (total > 0) {
      expenses += total;
      byCategory.push({ category, total });
      if (flex === 'fixed') flexData.fixed += total;
      else if (flex === 'flexible') flexData.flexible += total;
      else if (flex === 'discretionary') flexData.discretionary += total;
      else flexData.untagged += total;
    }
  }

  byCategory.sort((a, b) => b.total - a.total);
  return { summary: { income, expenses, net: income - expenses, byCategory }, flexData };
}

export type Rule = { id: number; priority: number; match_type: string; pattern: string; category: string; min_amount: number | null; max_amount: number | null };
export type NameRule = { id: number; match_type: string; pattern: string; replacement: string; min_amount: number | null; max_amount: number | null };
export type CategoryDetail = { name: string; flexibility: 'fixed' | 'flexible' | 'discretionary' | null };

export async function getAllRules(): Promise<Rule[]> {
  const result = await db.execute('SELECT id, priority, match_type, pattern, category, min_amount, max_amount FROM category_rules ORDER BY priority DESC, id ASC');
  return result.rows as unknown as Rule[];
}

export async function getAllNameRules(): Promise<NameRule[]> {
  const result = await db.execute('SELECT id, match_type, pattern, replacement, min_amount, max_amount FROM name_rules ORDER BY id ASC');
  return result.rows as unknown as NameRule[];
}

export async function getAllCategories(): Promise<string[]> {
  const result = await db.execute('SELECT name FROM categories ORDER BY name');
  return (result.rows as unknown as { name: string }[]).map((r) => r.name);
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

export type Tag = { id: number; name: string; count: number };

export async function getAllTags(): Promise<Tag[]> {
  const result = await db.execute(`
    SELECT t.id, t.name, COUNT(tt.transaction_id) as count
    FROM tags t
    LEFT JOIN transaction_tags tt ON tt.tag_id = t.id
    GROUP BY t.id ORDER BY t.name
  `);
  return (result.rows as unknown as { id: number; name: string; count: number }[]).map((r) => ({
    id: Number(r.id), name: r.name, count: Number(r.count),
  }));
}

export type SortMode = 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' | 'name-asc' | 'name-desc' | 'category-asc' | 'category-desc';
export const SORT_ORDER_BY: Record<SortMode, string> = {
  'date-desc':     't.date DESC, t.id DESC',
  'date-asc':      't.date ASC, t.id ASC',
  'amount-desc':   't.amount DESC',
  'amount-asc':    't.amount ASC',
  'name-asc':      'COALESCE(t.display_name, t.name) ASC',
  'name-desc':     'COALESCE(t.display_name, t.name) DESC',
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
  category?: string | null; from?: string | null; to?: string | null;
  search?: string; tag?: string | null; account?: string | null; sort?: SortMode;
}): Promise<TxRow[]> {
  const { category, from, to, search, tag, account, sort = 'date-desc' } = filters;
  const conditions: string[] = [];
  const args: (string | number | null)[] = [];

  if (category) { conditions.push('t.category = ?'); args.push(category); }
  if (from && to) { conditions.push('t.date >= ? AND t.date <= ?'); args.push(from, to); }
  if (tag) {
    conditions.push('EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id AND tg.name = ?)');
    args.push(tag);
  }
  if (account) { conditions.push('t.account_id = ?'); args.push(account); }

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
  return rows.filter((r) => re.test(r.display_name ?? r.name) || (r.merchant_name ? re.test(r.merchant_name) : false)).slice(0, 200);
}

export async function countSearchMatches(
  from: string, to: string, search: string, accountId?: string,
): Promise<{ count: number; expenses: number }> {
  if (!search) return { count: 0, expenses: 0 };
  const acctClause = accountId ? 'AND account_id = ?' : '';
  const args: (string | number | null)[] = accountId ? [from, to, accountId] : [from, to];
  const result = await db.execute({
    sql: `SELECT COALESCE(display_name, name) as display, merchant_name, amount
          FROM transactions WHERE date >= ? AND date <= ? ${acctClause} AND pending = 0 AND ignored = 0`,
    args,
  });
  const rows = result.rows as unknown as { display: string; merchant_name: string | null; amount: number }[];
  const re = buildSearchRe(search);
  const matches = rows.filter((r) => re.test(r.display) || (r.merchant_name ? re.test(r.merchant_name) : false));
  return { count: matches.length, expenses: matches.filter((r) => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0) };
}

export type LinkedAccount = { id: string; name: string; nickname: string | null; type: string; subtype: string | null; institution_name: string | null; mask: string | null; last_synced: string | null };

export async function getLinkedAccounts(): Promise<LinkedAccount[]> {
  const result = await db.execute(`
    SELECT a.id, a.name, a.nickname, a.type, a.subtype, a.institution_name, a.mask,
      (SELECT MAX(date) FROM balance_history WHERE account_id = a.id) as last_synced
    FROM accounts a
    ORDER BY CASE a.type WHEN 'depository' THEN 0 WHEN 'investment' THEN 1 WHEN 'credit' THEN 2 ELSE 3 END, a.name
  `);
  return result.rows as unknown as LinkedAccount[];
}

export type CsvAccount = { id: string; name: string; mask: string | null };

export async function getCsvAccounts(): Promise<CsvAccount[]> {
  const result = await db.execute('SELECT id, name, mask FROM accounts');
  return result.rows as unknown as CsvAccount[];
}

export type AccountBalance = { name: string; nickname: string | null; type: string; subtype: string | null; balance: number };
export type HistoryRow     = { date: string; assets: number; liabilities: number; net: number };

export async function getAccountsWithBalances(): Promise<{ accounts: AccountBalance[]; history: HistoryRow[] }> {
  const [acctResult, histResult] = await Promise.all([
    db.execute(`
      SELECT a.name, a.nickname, a.type, a.subtype, bh.balance
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
      GROUP BY bh.date ORDER BY bh.date
    `),
  ]);
  const accounts = acctResult.rows as unknown as AccountBalance[];
  const history = (histResult.rows as unknown as { date: string; assets: number; liabilities: number }[]).map((r) => ({
    ...r, assets: Number(r.assets), liabilities: Number(r.liabilities), net: Number(r.assets) - Number(r.liabilities),
  }));
  return { accounts, history };
}
