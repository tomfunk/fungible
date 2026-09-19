import React, { useEffect, useRef, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from 'recharts';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useNav } from '../hooks/useNav.js';
import { useFilter } from '../hooks/useFilter.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { fmt, fmtSigned, fmtCompact } from '../../../../core/fmt.js';
import type { TrendsRange } from '../../../../core/dateUtils.js';
import type { View, PeriodRow } from '../../../../core/trends.js';
import { useChartTheme, tooltipStyle, tooltipLabelStyle, type ChartTheme } from '../components/chartTheme.js';
import styles from './Trends.module.css';

const TRENDS_RANGES: TrendsRange[] = ['week', 'month', 'quarter', 'year'];
const RANGE_LABELS: Record<TrendsRange, string> = { week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

function viewColor(view: View, chartTheme: ChartTheme): string {
  if (view.mode === 'net') return chartTheme.accent;
  if (view.mode === 'income') return chartTheme.positive;
  if (view.mode === 'flex' && view.flex) return chartTheme[view.flex];
  return chartTheme.negative;
}

export function Trends() {
  const { txFilter, navigate } = useNav();
  const chartTheme = useChartTheme();

  const [views, setViews] = useState<View[]>([]);
  const [viewIdx, setViewIdx] = useState(0);
  const [range, setRange] = useState<TrendsRange>(() => {
    const r = txFilter.range;
    return r && (TRENDS_RANGES as string[]).includes(r) ? (r as TrendsRange) : 'month';
  });
  const [searchInput, setSearchInput] = useState(txFilter.search ?? '');
  const [search, setSearch] = useState(txFilter.search ?? '');

  useEffect(() => {
    void api.trends.buildTrendViews().then((loaded) => {
      setViews(loaded);
      if (txFilter.focusCategory) {
        const idx = loaded.findIndex((v) => v.category === txFilter.focusCategory);
        if (idx >= 0) setViewIdx(idx);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = views[viewIdx] as View | undefined;

  const { filter: sharedFilter, setFilter } = useFilter();
  const rows = useQuery(
    () => (view ? api.trends.getPeriodTotals(view, range, sharedFilter) : Promise.resolve([])),
    [viewIdx, range, views, sharedFilter],
  );
  const searchRows = useQuery(
    () => (search ? api.trends.getSearchPeriodTotals(search, range, sharedFilter) : Promise.resolve(null)),
    [search, range, sharedFilter],
  );
  const liveSearch = searchInput;
  const matchInfo = useQuery(
    () => (liveSearch ? api.trends.getSearchMatchingPeriods(liveSearch, range, sharedFilter) : Promise.resolve(null)),
    [liveSearch, range, sharedFilter],
  );

  const activeRows: PeriodRow[] = (search ? searchRows : rows) ?? [];

  const isNet = !search && view?.mode === 'net';
  const isFlexBreakdown = !search && view?.mode === 'flexbreakdown';
  const searchIncome = search ? activeRows.reduce((s, r) => s + (r.income ?? 0), 0) : 0;
  const searchExpenses = search ? activeRows.reduce((s, r) => s + (r.expenses ?? 0), 0) : 0;
  const searchBothSides = search && searchIncome > 0 && searchExpenses > 0;
  const netStyle = isNet || searchBothSides;

  const avg = activeRows.length ? activeRows.reduce((s, r) => s + r.total, 0) / activeRows.length : 0;
  const peak = activeRows.reduce(
    (best: PeriodRow | undefined, r) => (Math.abs(r.total) > Math.abs(best?.total ?? 0) ? r : best),
    activeRows[0],
  );

  function navToPeriod(row: PeriodRow | undefined) {
    // A category view drills in by writing the shared filter; drillFrom only
    // when a filter level was actually pushed, so Esc's pop stays balanced.
    if (!search && view?.category) setFilter({ ...sharedFilter, categories: [view.category] });
    navigate('transactions', {
      ...(row ? { from: row.from, to: row.to } : {}),
      ...(!search && view?.mode === 'income' ? { txType: 'income' as const } : {}),
      ...(!search && view?.mode === 'expenses' ? { txType: 'expenses' as const } : {}),
      ...(!search && view?.mode === 'flex' && view.flex ? { flex: view.flex } : {}),
      ...(search ? { search } : {}),
      ...(!search && view?.category ? { drillFrom: 'trends' as const } : {}),
    });
  }

  function onChartClick(state: { activeLabel?: unknown } | null) {
    if (!state || state.activeLabel === undefined) return;
    const row = activeRows.find((r) => r.label === state.activeLabel);
    if (row) navToPeriod(row);
  }

  const searchRef = useRef<HTMLInputElement>(null);
  useScreenKeys({
    r: () => setRange((r) => TRENDS_RANGES[(TRENDS_RANGES.indexOf(r) + 1) % TRENDS_RANGES.length]),
    ArrowLeft: () => {
      if (!search && views.length) setViewIdx((i) => (i - 1 + views.length) % views.length);
    },
    ArrowRight: () => {
      if (!search && views.length) setViewIdx((i) => (i + 1) % views.length);
    },
    '/': () => searchRef.current?.focus(),
    Escape: () => {
      if (search) {
        setSearch('');
        setSearchInput('');
      } else navigate('dashboard');
    },
  });

  const lineColor = view ? viewColor(view, chartTheme) : chartTheme.negative;
  const searchOnlyColor = searchIncome > 0 && searchExpenses === 0 ? chartTheme.positive : chartTheme.negative;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [r] range   [← →] view   [/] search   [esc] back" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Trends</h1>
        {!search && views.length > 0 && (
          <select
            className={styles.viewSelect}
            value={viewIdx}
            onChange={(e) => setViewIdx(Number(e.target.value))}
          >
            {views.map((v, i) => (
              <option key={`${v.label}-${i}`} value={i}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <div className={styles.rangePills}>
          {TRENDS_RANGES.map((r) => (
            <button key={r} className={r === range ? styles.pillActive : styles.pill} onClick={() => setRange(r)}>
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className={styles.searchWrap}>
          <input
            ref={searchRef}
            className={styles.search}
            placeholder="Search transactions…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSearch(searchInput);
              if (e.key === 'Escape') {
                setSearch('');
                setSearchInput('');
                searchRef.current?.blur();
              }
            }}
          />
          {matchInfo && searchInput && (
            <span className="dim">
              {matchInfo.count} txn{matchInfo.count === 1 ? '' : 's'}
              {search && activeRows.length > 0 ? ` · ${activeRows.length} periods` : ''}
            </span>
          )}
          {search && (
            <button
              className={styles.clearSearch}
              onClick={() => {
                setSearch('');
                setSearchInput('');
              }}
            >
              clear
            </button>
          )}
        </div>
      </div>

      <section className={styles.panel}>
        {activeRows.length === 0 ? (
          <p className="dim">{search ? 'No periods match the search.' : 'No data.'}</p>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={activeRows} onClick={onChartClick} style={{ cursor: 'pointer' }}>
              <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" stroke={chartTheme.axis} tick={{ fontSize: 12 }} minTickGap={24} />
              <YAxis stroke={chartTheme.axis} tick={{ fontSize: 12 }} tickFormatter={(v: number) => fmtCompact(v)} width={70} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={tooltipLabelStyle}
                formatter={(value, name) => [fmt(Number(value)), String(name)]}
              />
              {netStyle ? (
                <>
                  <Legend />
                  <ReferenceLine y={0} stroke={chartTheme.axis} />
                  <Bar dataKey="income" name="Income" fill={chartTheme.positive} />
                  <Bar dataKey="expenses" name="Expenses" fill={chartTheme.negative} />
                  <Bar dataKey="total" name="Net" fill={chartTheme.accent} />
                </>
              ) : isFlexBreakdown ? (
                <>
                  <Legend />
                  <Bar dataKey="fixed" name="Fixed" stackId="flex" fill={chartTheme.fixed} />
                  <Bar dataKey="flexible" name="Flexible" stackId="flex" fill={chartTheme.flexible} />
                  <Bar dataKey="discretionary" name="Discretionary" stackId="flex" fill={chartTheme.discretionary} />
                </>
              ) : (
                <Bar
                  dataKey="total"
                  name={search ? `"${search}"` : view?.label ?? ''}
                  fill={search ? searchOnlyColor : lineColor}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
        {activeRows.length > 0 && <p className={`dim ${styles.chartHint}`}>Click a bar to see its transactions</p>}
      </section>

      {activeRows.length > 0 && (
        <div className={styles.cards}>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Periods</div>
            <div className={`num ${styles.cardValue}`}>{activeRows.length}</div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Avg / {RANGE_LABELS[range].toLowerCase()}</div>
            <div className={`num ${netStyle ? (avg >= 0 ? 'pos' : 'neg') : ''} ${styles.cardValue}`}>
              {netStyle ? fmtSigned(avg) : fmt(avg)}
            </div>
          </div>
          {peak && peak.total !== 0 && (
            <button className={`${styles.card} ${styles.cardClickable}`} onClick={() => navToPeriod(peak)}>
              <div className={styles.cardLabel}>Peak</div>
              <div className={styles.cardValue}>
                {peak.label} <span className="num dim">{netStyle ? fmtSigned(peak.total) : fmt(peak.total)}</span>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
