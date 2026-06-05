import { db } from './db.js';
import { MONTHS, addDays, weekLabel, type TrendsRange } from './dateUtils.js';
import { buildSearchRe } from './queries.js';

const pad = (n: number) => String(n).padStart(2, '0');
const Q_FROM = ['01', '04', '07', '10'];
const Q_TO   = ['03', '06', '09', '12'];

export type FlexTier = 'fixed' | 'flexible' | 'discretionary';
export type ViewMode = 'expenses' | 'income' | 'net' | 'category' | 'flex' | 'flexbreakdown';
export type View = { mode: ViewMode; category: string | null; flex: FlexTier | null; label: string };
export type PeriodRow = {
  label: string; from: string; to: string; total: number;
  income?: number; expenses?: number; fixed?: number; flexible?: number; discretionary?: number;
};

export async function buildTrendViews(): Promise<View[]> {
  const result = await db.execute(`
    SELECT t.category, SUM(t.amount) as total
    FROM transactions t
    WHERE t.pending = 0 AND t.ignored = 0 AND t.amount > 0
      AND t.category NOT IN (SELECT category FROM hidden_categories)
    GROUP BY t.category ORDER BY total DESC
  `);
  const cats = result.rows as unknown as { category: string }[];
  return [
    { mode: 'expenses',      category: null, flex: null,            label: 'Expenses'      },
    { mode: 'income',        category: null, flex: null,            label: 'Income'        },
    { mode: 'net',           category: null, flex: null,            label: 'Net'           },
    { mode: 'flexbreakdown', category: null, flex: null,            label: 'Flexibility'   },
    { mode: 'flex',          category: null, flex: 'fixed',         label: 'Fixed'         },
    { mode: 'flex',          category: null, flex: 'flexible',      label: 'Flexible'      },
    { mode: 'flex',          category: null, flex: 'discretionary', label: 'Discretionary' },
    ...cats.map((r) => ({ mode: 'category' as ViewMode, category: r.category, flex: null, label: r.category })),
  ];
}

export async function generateAllPeriods(range: TrendsRange): Promise<Array<{ label: string; from: string; to: string }>> {
  const boundsResult = await db.execute(
    'SELECT MIN(date) as minDate, MAX(date) as maxDate FROM transactions WHERE pending = 0 AND ignored = 0'
  );
  const bounds = boundsResult.rows[0] as unknown as { minDate: string | null; maxDate: string | null };
  if (!bounds.minDate || !bounds.maxDate) return [];

  const result: Array<{ label: string; from: string; to: string }> = [];

  if (range === 'month') {
    let y = parseInt(bounds.minDate.slice(0, 4));
    let m = parseInt(bounds.minDate.slice(5, 7));
    const endY = parseInt(bounds.maxDate.slice(0, 4));
    const endM = parseInt(bounds.maxDate.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      result.push({ label: `${MONTHS[m - 1]} ${y}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-31` });
      if (++m > 12) { m = 1; y++; }
    }
  } else if (range === 'quarter') {
    let y = parseInt(bounds.minDate.slice(0, 4));
    let q = Math.floor((parseInt(bounds.minDate.slice(5, 7)) - 1) / 3) + 1;
    const endY = parseInt(bounds.maxDate.slice(0, 4));
    const endQ = Math.floor((parseInt(bounds.maxDate.slice(5, 7)) - 1) / 3) + 1;
    while (y < endY || (y === endY && q <= endQ)) {
      result.push({ label: `Q${q} ${y}`, from: `${y}-${Q_FROM[q - 1]}-01`, to: `${y}-${Q_TO[q - 1]}-31` });
      if (++q > 4) { q = 1; y++; }
    }
  } else if (range === 'year') {
    let y = parseInt(bounds.minDate.slice(0, 4));
    const endY = parseInt(bounds.maxDate.slice(0, 4));
    while (y <= endY) {
      result.push({ label: `${y}`, from: `${y}-01-01`, to: `${y}-12-31` });
      y++;
    }
  } else {
    const startResult = await db.execute({
      sql: `SELECT date(?, '-' || ((CAST(strftime('%w', ?) AS INTEGER)+6)%7) || ' days') as ws`,
      args: [bounds.minDate, bounds.minDate],
    });
    let current = (startResult.rows[0] as unknown as { ws: string }).ws;
    while (current <= bounds.maxDate) {
      const to = addDays(current, 6);
      result.push({ label: weekLabel(current, to), from: current, to });
      current = addDays(current, 7);
    }
  }
  return result;
}

export async function getPeriodTotals(view: View, range: TrendsRange): Promise<PeriodRow[]> {
  const allPeriods = await generateAllPeriods(range);

  if (view.mode === 'flexbreakdown') {
    const flexExpr = `
      SUM(CASE WHEN c.flexibility = 'fixed'         THEN cat.total ELSE 0 END) as fixed,
      SUM(CASE WHEN c.flexibility = 'flexible'      THEN cat.total ELSE 0 END) as flexible,
      SUM(CASE WHEN c.flexibility = 'discretionary' THEN cat.total ELSE 0 END) as discretionary,
      SUM(cat.total) as total
    `;
    let sql: string;
    if (range === 'month') {
      sql = `
        SELECT cat.y, cat.m, ${flexExpr}
        FROM (
          SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, CAST(substr(t.date,6,2) AS INTEGER) as m,
            t.category, SUM(t.amount) as total
          FROM transactions t
          WHERE t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY y, m, t.category HAVING SUM(t.amount) > 0
        ) cat LEFT JOIN categories c ON c.name = cat.category
        GROUP BY cat.y, cat.m ORDER BY cat.y, cat.m
      `;
    } else if (range === 'quarter') {
      sql = `
        SELECT cat.y, cat.q, ${flexExpr}
        FROM (
          SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, (CAST(substr(t.date,6,2) AS INTEGER)-1)/3+1 as q,
            t.category, SUM(t.amount) as total
          FROM transactions t
          WHERE t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY y, q, t.category HAVING SUM(t.amount) > 0
        ) cat LEFT JOIN categories c ON c.name = cat.category
        GROUP BY cat.y, cat.q ORDER BY cat.y, cat.q
      `;
    } else if (range === 'year') {
      sql = `
        SELECT cat.y, ${flexExpr}
        FROM (
          SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, t.category, SUM(t.amount) as total
          FROM transactions t
          WHERE t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY y, t.category HAVING SUM(t.amount) > 0
        ) cat LEFT JOIN categories c ON c.name = cat.category
        GROUP BY cat.y ORDER BY cat.y
      `;
    } else {
      sql = `
        SELECT cat.week_start, ${flexExpr}
        FROM (
          SELECT date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER)+6)%7) || ' days') as week_start,
            t.category, SUM(t.amount) as total
          FROM transactions t
          WHERE t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY week_start, t.category HAVING SUM(t.amount) > 0
        ) cat LEFT JOIN categories c ON c.name = cat.category
        GROUP BY cat.week_start ORDER BY cat.week_start
      `;
    }
    const rawResult = await db.execute(sql);
    const rawRows = rawResult.rows as unknown as any[];

    const actual = new Map<string, PeriodRow>();
    for (const r of rawRows) {
      let from: string, label: string;
      if (range === 'month')        { from = `${r.y}-${pad(r.m)}-01`;        label = `${MONTHS[r.m - 1]} ${r.y}`; }
      else if (range === 'quarter') { from = `${r.y}-${Q_FROM[r.q - 1]}-01`; label = `Q${r.q} ${r.y}`; }
      else if (range === 'year')    { from = `${r.y}-01-01`;                 label = `${r.y}`; }
      else                          { from = r.week_start; label = weekLabel(r.week_start, addDays(r.week_start, 6)); }
      const p = allPeriods.find((p) => p.from === from);
      actual.set(from, {
        label, from, to: p?.to ?? from,
        total: Number(r.total) ?? 0,
        fixed: Number(r.fixed) ?? 0,
        flexible: Number(r.flexible) ?? 0,
        discretionary: Number(r.discretionary) ?? 0,
      });
    }
    return allPeriods.map((p) => actual.get(p.from) ?? { ...p, total: 0, fixed: 0, flexible: 0, discretionary: 0 });
  }

  const catFilter = view.category
    ? `AND t.category = '${view.category.replace(/'/g, "''")}'`
    : view.flex
    ? `AND EXISTS (SELECT 1 FROM categories c WHERE c.name = t.category AND c.flexibility = '${view.flex}')`
    : 'AND t.category NOT IN (SELECT category FROM hidden_categories)';

  const amtFilter = view.mode === 'income' ? 'AND t.amount < 0' : view.mode === 'net' ? '' : 'AND t.amount > 0';
  const base = `FROM transactions t WHERE t.pending = 0 AND t.ignored = 0 ${amtFilter} ${catFilter}`;
  const isNet = view.mode === 'net';
  const totalExpr = isNet
    ? 'SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as income, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as expenses, SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE -t.amount END) as total'
    : 'SUM(ABS(t.amount)) as total';
  const zeroRow = (p: { label: string; from: string; to: string }): PeriodRow =>
    ({ ...p, total: 0, ...(isNet ? { income: 0, expenses: 0 } : {}) });

  let sql: string;
  let toActual: (r: any) => PeriodRow;

  if (range === 'month') {
    sql = `SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, CAST(substr(t.date,6,2) AS INTEGER) as m, ${totalExpr} ${base} GROUP BY y, m ORDER BY y, m`;
    toActual = (r) => ({ label: `${MONTHS[r.m - 1]} ${r.y}`, from: `${r.y}-${pad(r.m)}-01`, to: `${r.y}-${pad(r.m)}-31`, total: Number(r.total), ...(isNet ? { income: Number(r.income), expenses: Number(r.expenses) } : {}) });
  } else if (range === 'quarter') {
    sql = `SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, (CAST(substr(t.date,6,2) AS INTEGER)-1)/3+1 as q, ${totalExpr} ${base} GROUP BY y, q ORDER BY y, q`;
    toActual = (r) => ({ label: `Q${r.q} ${r.y}`, from: `${r.y}-${Q_FROM[r.q - 1]}-01`, to: `${r.y}-${Q_TO[r.q - 1]}-31`, total: Number(r.total), ...(isNet ? { income: Number(r.income), expenses: Number(r.expenses) } : {}) });
  } else if (range === 'year') {
    sql = `SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, ${totalExpr} ${base} GROUP BY y ORDER BY y`;
    toActual = (r) => ({ label: `${r.y}`, from: `${r.y}-01-01`, to: `${r.y}-12-31`, total: Number(r.total), ...(isNet ? { income: Number(r.income), expenses: Number(r.expenses) } : {}) });
  } else {
    sql = `SELECT date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER)+6)%7) || ' days') as week_start, ${totalExpr} ${base} GROUP BY week_start ORDER BY week_start`;
    toActual = (r) => {
      const to = addDays(r.week_start, 6);
      return { label: weekLabel(r.week_start, to), from: r.week_start, to, total: Number(r.total), ...(isNet ? { income: Number(r.income), expenses: Number(r.expenses) } : {}) };
    };
  }

  const rawResult = await db.execute(sql);
  const rawRows = rawResult.rows as unknown as any[];
  const actual = new Map<string, PeriodRow>(rawRows.map((r) => { const row = toActual(r); return [row.from, row]; }));
  return allPeriods.map((p) => actual.get(p.from) ?? zeroRow(p));
}

function periodFrom(date: string, range: TrendsRange): string {
  if (range === 'month') return date.slice(0, 7) + '-01';
  if (range === 'quarter') {
    const m = parseInt(date.slice(5, 7));
    return date.slice(0, 4) + '-' + Q_FROM[Math.floor((m - 1) / 3)] + '-01';
  }
  if (range === 'year') return date.slice(0, 4) + '-01-01';
  const dt = new Date(date + 'T12:00:00');
  const dow = (dt.getDay() + 6) % 7;
  const mon = new Date(dt);
  mon.setDate(dt.getDate() - dow);
  return mon.toISOString().slice(0, 10);
}

export async function getSearchPeriodTotals(search: string, range: TrendsRange): Promise<PeriodRow[]> {
  if (!search) return [];
  const result = await db.execute(`
    SELECT COALESCE(display_name, name) as display, merchant_name, date, amount
    FROM transactions WHERE pending = 0 AND ignored = 0
  `);
  const rows = result.rows as unknown as { display: string; merchant_name: string | null; date: string; amount: number }[];
  const re = buildSearchRe(search);
  const periodMap = new Map<string, { income: number; expenses: number }>();
  for (const row of rows) {
    if (!re.test(row.display) && !(row.merchant_name ? re.test(row.merchant_name) : false)) continue;
    const from = periodFrom(row.date, range);
    const existing = periodMap.get(from) ?? { income: 0, expenses: 0 };
    const amt = Number(row.amount);
    if (amt < 0) existing.income += Math.abs(amt); else existing.expenses += amt;
    periodMap.set(from, existing);
  }
  const allPeriods = await generateAllPeriods(range);
  return allPeriods
    .filter((p) => periodMap.has(p.from))
    .map((p) => {
      const { income, expenses } = periodMap.get(p.from)!;
      return { ...p, income, expenses, total: income - expenses };
    });
}

export async function getSearchMatchingPeriods(
  search: string,
  range: TrendsRange,
): Promise<{ periods: Set<string>; count: number }> {
  if (!search) return { periods: new Set(), count: 0 };
  const result = await db.execute(`
    SELECT COALESCE(display_name, name) as display, merchant_name, date
    FROM transactions WHERE pending = 0 AND ignored = 0
  `);
  const rows = result.rows as unknown as { display: string; merchant_name: string | null; date: string }[];
  const re = buildSearchRe(search);
  const periods = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (!re.test(row.display) && !(row.merchant_name ? re.test(row.merchant_name) : false)) continue;
    count++;
    periods.add(periodFrom(row.date, range));
  }
  return { periods, count };
}
