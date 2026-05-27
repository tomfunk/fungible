import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { db } from '../core/db.js';
import { addDays, weekLabel, type TrendsRange } from '../core/dateUtils.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, fmtSigned, bar, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth } from './useTerminalWidth.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const Q_FROM = ['01', '04', '07', '10'];
const Q_TO   = ['03', '06', '09', '12'];

const TRENDS_RANGES: TrendsRange[] = ['week', 'month', 'quarter', 'year'];
const RANGE_LABELS: Record<TrendsRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

type FlexTier = 'fixed' | 'flexible' | 'discretionary';
type ViewMode = 'expenses' | 'income' | 'net' | 'category' | 'flex' | 'flexbreakdown';

type View = {
  mode: ViewMode;
  category: string | null;
  flex: FlexTier | null;
  label: string;
};

type PeriodRow = {
  label: string; from: string; to: string;
  total: number;
  income?: number; expenses?: number;       // net mode
  fixed?: number; flexible?: number; discretionary?: number; // flexbreakdown mode
};

const FLEX_COLORS: Record<FlexTier, string> = { fixed: 'red', flexible: 'yellow', discretionary: 'cyan' };

function buildViews(): View[] {
  const cats = db.prepare(`
    SELECT t.category, SUM(t.amount) as total
    FROM transactions t
    WHERE t.pending = 0 AND t.ignored = 0 AND t.amount > 0
      AND t.category NOT IN (SELECT category FROM hidden_categories)
    GROUP BY t.category
    ORDER BY total DESC
  `).all() as { category: string }[];

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

// Returns all periods in the DB date range, so we always show a consistent row count.
function generateAllPeriods(range: TrendsRange): Array<{ label: string; from: string; to: string }> {
  const bounds = db.prepare(`
    SELECT MIN(date) as minDate, MAX(date) as maxDate
    FROM transactions WHERE pending = 0 AND ignored = 0
  `).get() as { minDate: string | null; maxDate: string | null };
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
    // week — find Monday of the week containing minDate
    const startRow = db.prepare(
      `SELECT date(?, '-' || ((CAST(strftime('%w', ?) AS INTEGER)+6)%7) || ' days') as ws`
    ).get(bounds.minDate, bounds.minDate) as { ws: string };
    let current = startRow.ws;
    while (current <= bounds.maxDate) {
      const to = addDays(current, 6);
      result.push({ label: weekLabel(current, to), from: current, to });
      current = addDays(current, 7);
    }
  }
  return result;
}

function getPeriodTotals(view: View, range: TrendsRange): PeriodRow[] {
  const allPeriods = generateAllPeriods(range);

  // --- Flex breakdown: all three tiers per period ---
  // Group by category first (HAVING SUM > 0) so refunds net out before bucketing by tier,
  // matching the same aggregation logic as getFlexSummary in queries.ts.
  if (view.mode === 'flexbreakdown') {
    const flexExpr = `
      SUM(CASE WHEN c.flexibility = 'fixed'         THEN cat.total ELSE 0 END) as fixed,
      SUM(CASE WHEN c.flexibility = 'flexible'      THEN cat.total ELSE 0 END) as flexible,
      SUM(CASE WHEN c.flexibility = 'discretionary' THEN cat.total ELSE 0 END) as discretionary,
      SUM(cat.total) as total
    `;
    let rawRows: any[];
    if (range === 'month') {
      rawRows = db.prepare(`
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
      `).all() as any[];
    } else if (range === 'quarter') {
      rawRows = db.prepare(`
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
      `).all() as any[];
    } else if (range === 'year') {
      rawRows = db.prepare(`
        SELECT cat.y, ${flexExpr}
        FROM (
          SELECT CAST(substr(t.date,1,4) AS INTEGER) as y,
            t.category, SUM(t.amount) as total
          FROM transactions t
          WHERE t.pending = 0 AND t.ignored = 0
            AND t.category NOT IN (SELECT category FROM hidden_categories)
          GROUP BY y, t.category HAVING SUM(t.amount) > 0
        ) cat LEFT JOIN categories c ON c.name = cat.category
        GROUP BY cat.y ORDER BY cat.y
      `).all() as any[];
    } else {
      rawRows = db.prepare(`
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
      `).all() as any[];
    }

    const actual = new Map<string, PeriodRow>();
    for (const r of rawRows) {
      let from: string, label: string;
      if (range === 'month')   { from = `${r.y}-${pad(r.m)}-01`; label = `${MONTHS[r.m - 1]} ${r.y}`; }
      else if (range === 'quarter') { from = `${r.y}-${Q_FROM[r.q - 1]}-01`; label = `Q${r.q} ${r.y}`; }
      else if (range === 'year') { from = `${r.y}-01-01`; label = `${r.y}`; }
      else { from = r.week_start; label = weekLabel(r.week_start, addDays(r.week_start, 6)); }
      const p = allPeriods.find((p) => p.from === from);
      actual.set(from, {
        label, from, to: p?.to ?? from,
        total: r.total ?? 0, fixed: r.fixed ?? 0, flexible: r.flexible ?? 0, discretionary: r.discretionary ?? 0,
      });
    }
    return allPeriods.map((p) => actual.get(p.from) ?? { ...p, total: 0, fixed: 0, flexible: 0, discretionary: 0 });
  }

  // --- Standard modes ---
  const catFilter = view.category
    ? `AND t.category = '${view.category.replace(/'/g, "''")}'`
    : view.flex
    ? `AND EXISTS (SELECT 1 FROM categories c WHERE c.name = t.category AND c.flexibility = '${view.flex}')`
    : 'AND t.category NOT IN (SELECT category FROM hidden_categories)';

  const amtFilter = view.mode === 'income' ? 'AND t.amount < 0' :
                    view.mode === 'net'     ? '' : 'AND t.amount > 0';

  const base = `FROM transactions t WHERE t.pending = 0 AND t.ignored = 0 ${amtFilter} ${catFilter}`;

  const isNet = view.mode === 'net';
  const totalExpr = isNet
    ? 'SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as income, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as expenses, SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE -t.amount END) as total'
    : 'SUM(ABS(t.amount)) as total';

  const zeroRow = (p: { label: string; from: string; to: string }): PeriodRow =>
    ({ ...p, total: 0, ...(isNet ? { income: 0, expenses: 0 } : {}) });

  let rawRows: any[];
  let toActual: (r: any) => PeriodRow;

  if (range === 'month') {
    rawRows = db.prepare(`
      SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, CAST(substr(t.date,6,2) AS INTEGER) as m, ${totalExpr}
      ${base} GROUP BY y, m ORDER BY y, m
    `).all() as any[];
    toActual = (r) => ({
      label: `${MONTHS[r.m - 1]} ${r.y}`,
      from: `${r.y}-${pad(r.m)}-01`, to: `${r.y}-${pad(r.m)}-31`,
      total: r.total, ...(isNet ? { income: r.income, expenses: r.expenses } : {}),
    });
  } else if (range === 'quarter') {
    rawRows = db.prepare(`
      SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, (CAST(substr(t.date,6,2) AS INTEGER)-1)/3+1 as q, ${totalExpr}
      ${base} GROUP BY y, q ORDER BY y, q
    `).all() as any[];
    toActual = (r) => ({
      label: `Q${r.q} ${r.y}`,
      from: `${r.y}-${Q_FROM[r.q - 1]}-01`, to: `${r.y}-${Q_TO[r.q - 1]}-31`,
      total: r.total, ...(isNet ? { income: r.income, expenses: r.expenses } : {}),
    });
  } else if (range === 'year') {
    rawRows = db.prepare(`
      SELECT CAST(substr(t.date,1,4) AS INTEGER) as y, ${totalExpr}
      ${base} GROUP BY y ORDER BY y
    `).all() as any[];
    toActual = (r) => ({
      label: `${r.y}`, from: `${r.y}-01-01`, to: `${r.y}-12-31`,
      total: r.total, ...(isNet ? { income: r.income, expenses: r.expenses } : {}),
    });
  } else {
    rawRows = db.prepare(`
      SELECT date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER)+6)%7) || ' days') as week_start, ${totalExpr}
      ${base} GROUP BY week_start ORDER BY week_start
    `).all() as any[];
    toActual = (r) => {
      const to = addDays(r.week_start, 6);
      return { label: weekLabel(r.week_start, to), from: r.week_start, to,
               total: r.total, ...(isNet ? { income: r.income, expenses: r.expenses } : {}) };
    };
  }

  const actual = new Map<string, PeriodRow>(rawRows.map((r) => { const row = toActual(r); return [row.from, row]; }));
  return allPeriods.map((p) => actual.get(p.from) ?? zeroRow(p));
}

function viewColor(view: View): string {
  if (view.mode === 'net')           return 'cyan';
  if (view.mode === 'income')        return 'green';
  if (view.mode === 'flexbreakdown') return 'white';
  if (view.mode === 'flex' && view.flex) return FLEX_COLORS[view.flex];
  return 'red';
}

export function Trends({
  onNavigate,
  initialFilter,
  isActive,
  showHints,
}: {
  onNavigate: (s: Screen, f?: TxFilter) => void;
  initialFilter?: TxFilter;
  isActive?: boolean;
  showHints: boolean;
}) {
  const [views] = useState<View[]>(buildViews);
  const [viewIdx, setViewIdx] = useState(() => {
    const cat = initialFilter?.category ?? null;
    if (!cat) return 0;
    const idx = views.findIndex((v) => v.category === cat);
    return idx >= 0 ? idx : 0;
  });
  const [range, setRange] = useState<TrendsRange>('month');
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [cursor, setCursor] = useState(0);

  const view = views[viewIdx] ?? views[0];
  const isNet = view.mode === 'net';
  const isFlexBreakdown = view.mode === 'flexbreakdown';

  useEffect(() => {
    const data = getPeriodTotals(view, range);
    setRows(data);
    setCursor(Math.max(0, data.length - 1));
  }, [viewIdx, range]);

  useInput((input, key) => {
    if (key.escape) { onNavigate('dashboard'); return; }
    if (handleNavKey(input, 'trends', onNavigate)) return;
    if (key.leftArrow)  { setViewIdx((i) => (i - 1 + views.length) % views.length); return; }
    if (key.rightArrow) { setViewIdx((i) => (i + 1) % views.length); return; }
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (input === 'r') {
      setRange((r) => TRENDS_RANGES[(TRENDS_RANGES.indexOf(r) + 1) % TRENDS_RANGES.length]);
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row) onNavigate('transactions', { category: view.category ?? undefined, from: row.from, to: row.to });
    }
  }, { isActive: isActive !== false });

  const PAGE = 30;
  const pageStart = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), rows.length - PAGE));
  const visible = rows.slice(pageStart, pageStart + PAGE);

  // Scale maxes
  const maxIncome   = isNet ? Math.max(...rows.map((r) => r.income   ?? 0), 1) : 1;
  const maxExpenses = isNet ? Math.max(...rows.map((r) => r.expenses ?? 0), 1) : 1;
  const netMax = Math.max(maxIncome, maxExpenses);

  const flexMax = isFlexBreakdown
    ? Math.max(...rows.flatMap((r) => [r.fixed ?? 0, r.flexible ?? 0, r.discretionary ?? 0]), 1)
    : 1;

  const absMax = isNet          ? netMax
               : isFlexBreakdown ? flexMax
               : Math.max(...rows.map((r) => Math.abs(r.total)), 1);

  const avg  = rows.length ? rows.reduce((s, r) => s + r.total, 0) / rows.length : 0;
  const peak = rows.reduce((best, r) => Math.abs(r.total) > Math.abs(best?.total ?? 0) ? r : best, rows[0]);

  const labelWidth = range === 'week' ? 22 : range === 'month' ? 10 : range === 'quarter' ? 8 : 6;
  const color = viewColor(view);
  const posLabel = `${viewIdx + 1} / ${views.length}`;

  const termW = useTerminalWidth();
  const inner = Math.max(70, termW) - 4;
  const rowBase = 2 + labelWidth; // selector + label
  // Regular: [rowBase] gap [total=13] gap [bar] — 2 gaps of 2
  const BAR_WIDTH = Math.max(8, inner - rowBase - 13 - 4);
  // Net: [rowBase] gap [net=13] gap [leftBar] gap [|=1] gap [rightBar] — 4 gaps of 1
  const HALF_BAR = Math.max(6, Math.floor((inner - rowBase - 13 - 4) / 2));
  // Flex: [rowBase] gap [total=13] gap [bar1] gap [bar2] gap [bar3] — 4 gaps of 2
  const FLEX_BAR = Math.max(5, Math.floor((inner - rowBase - 13 - 8) / 3));

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="trends" showHints={showHints} />
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Text bold>Trends</Text>
        {showHints && <Text dimColor>← → view  ·  ↑↓ navigate  ·  [r] range  ·  Enter drill in</Text>}
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={2}>
          {TRENDS_RANGES.map((r) => (
            <Text key={r} color={r === range ? 'cyan' : undefined} dimColor={r !== range} bold={r === range}>
              {RANGE_LABELS[r]}
            </Text>
          ))}
          {showHints && <Text dimColor>[r]</Text>}
        </Box>
        <Box gap={2}>
          <Text bold>{view.label}</Text>
          <Text dimColor>← {posLabel} →</Text>
        </Box>
      </Box>
      <Divider />

      {rows.length === 0 ? (
        <Box marginTop={1}><Text dimColor>No data.</Text></Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {isNet && (
              <Box gap={1} marginBottom={1}>
                <Text dimColor>{' '.repeat(2 + labelWidth)}</Text>
                <Text dimColor>{''.padStart(13)}</Text>
                <Text color="red" dimColor>{'expenses ←'.padStart(HALF_BAR)}</Text>
                <Text dimColor>{'|'}</Text>
                <Text color="green">{'→ income'}</Text>
              </Box>
            )}
            {isFlexBreakdown && (
              <Box gap={2} marginBottom={1}>
                <Text dimColor>{' '.repeat(2 + labelWidth)}</Text>
                <Text dimColor>{''.padStart(13)}</Text>
                <Text color="red"    dimColor>{'fixed'.padEnd(FLEX_BAR)}</Text>
                <Text color="yellow" dimColor>{'flexible'.padEnd(FLEX_BAR)}</Text>
                <Text color="cyan"   dimColor>{'discr'}</Text>
              </Box>
            )}
            {visible.map((row, i) => {
              const isSelected = rows[pageStart + i] === rows[cursor];

              if (isNet && row.income !== undefined && row.expenses !== undefined) {
                const expFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.expenses / netMax) * HALF_BAR)));
                const incFilled = Math.min(HALF_BAR, Math.max(0, Math.round((row.income  / netMax) * HALF_BAR)));
                const leftBar  = '░'.repeat(HALF_BAR - expFilled) + '█'.repeat(expFilled);
                const rightBar = '█'.repeat(incFilled) + '░'.repeat(HALF_BAR - incFilled);
                const net = row.income - row.expenses;
                return (
                  <Box key={row.from} gap={1}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                    </Text>
                    <Text color={net >= 0 ? 'green' : 'red'} dimColor={!isSelected}>
                      {fmtSigned(net).padStart(13)}
                    </Text>
                    <Text color="red"   dimColor={!isSelected}>{leftBar}</Text>
                    <Text dimColor>|</Text>
                    <Text color="green" dimColor={!isSelected}>{rightBar}</Text>
                  </Box>
                );
              }

              if (isFlexBreakdown) {
                const fixedF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.fixed ?? 0) / flexMax) * FLEX_BAR)));
                const flexF  = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.flexible ?? 0) / flexMax) * FLEX_BAR)));
                const discrF = Math.min(FLEX_BAR, Math.max(0, Math.round(((row.discretionary ?? 0) / flexMax) * FLEX_BAR)));
                return (
                  <Box key={row.from} gap={2}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                    </Text>
                    <Text color={isSelected ? 'white' : undefined} dimColor={!isSelected}>
                      {fmt(row.total).padStart(13)}
                    </Text>
                    <Text color="red"    dimColor={!isSelected}>{'█'.repeat(fixedF) + '░'.repeat(FLEX_BAR - fixedF)}</Text>
                    <Text color="yellow" dimColor={!isSelected}>{'█'.repeat(flexF)  + '░'.repeat(FLEX_BAR - flexF)}</Text>
                    <Text color="cyan"   dimColor={!isSelected}>{'█'.repeat(discrF) + '░'.repeat(FLEX_BAR - discrF)}</Text>
                  </Box>
                );
              }

              return (
                <Box key={row.from} gap={2}>
                  <Text color={isSelected ? 'cyan' : undefined}>
                    {isSelected ? '▶ ' : '  '}{row.label.padEnd(labelWidth)}
                  </Text>
                  <Text color={isSelected ? 'white' : undefined} dimColor={!isSelected}>
                    {fmt(row.total).padStart(13)}
                  </Text>
                  <Text color={color} dimColor={!isSelected}>
                    {bar(row.total, absMax, BAR_WIDTH)}
                  </Text>
                </Box>
              );
            })}
          </Box>

          <Box marginTop={1}><Divider /></Box>
          <Box gap={6} marginTop={1}>
            <Box flexDirection="column">
              <Text dimColor>periods</Text>
              <Text bold>{rows.length}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>avg/{RANGE_LABELS[range].toLowerCase()}</Text>
              <Text bold color={isNet ? (avg >= 0 ? 'green' : 'red') : undefined}>
                {isNet ? fmtSigned(avg) : fmt(avg)}
              </Text>
            </Box>
            {peak && peak.total > 0 && (
              <Box flexDirection="column">
                <Text dimColor>peak</Text>
                <Text bold>
                  {peak.label}{' '}
                  <Text dimColor>{isNet ? fmtSigned(peak.total) : fmt(peak.total)}</Text>
                </Text>
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
