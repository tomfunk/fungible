import React, { useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { fmt, fmtSigned, fmtCompact } from '../../../../core/fmt.js';
import type { AccountBalance, NetWorthGranularity } from '../../../../core/queries.js';
import { isAssetAccount, isLiabilityAccount } from '../../../../core/account-class.js';
import { CHART, tooltipStyle, tooltipLabelStyle } from '../components/chartTheme.js';
import { useNav } from '../hooks/useNav.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { SUBTYPE_DISPLAY, MONTHS } from '../constants.js';
import styles from './NetWorth.module.css';

const NW_RANGES: NetWorthGranularity[] = ['week', 'month', 'quarter', 'year'];
const NW_RANGE_LABELS: Record<string, string> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

type TypeBalance = { label: string; balance: number };

function groupByType(accs: AccountBalance[]): TypeBalance[] {
  const map = new Map<string, number>();
  for (const a of accs) {
    const raw = a.subtype ?? a.type;
    const key = SUBTYPE_DISPLAY[raw] ?? raw;
    map.set(key, (map.get(key) ?? 0) + a.balance);
  }
  return [...map.entries()]
    .map(([label, balance]) => ({ label, balance }))
    .sort((a, b) => b.balance - a.balance);
}

function buildTypeToIds(accs: AccountBalance[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of accs) {
    const key = SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type);
    const existing = map.get(key);
    if (existing) existing.push(a.id); else map.set(key, [a.id]);
  }
  return map;
}

function periodLabel(period: string, range: NetWorthGranularity): string {
  if (range === 'year') return period;
  if (range === 'quarter') {
    const [y, q] = period.split('-');
    return `${q} ${y}`;
  }
  if (range === 'month') {
    const [y, m] = period.split('-');
    return `${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  const [y, w] = period.split('-');
  return `${w} ${y}`;
}

type SeriesKey = 'assets' | 'liabilities' | 'net';
const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'assets',      label: 'Assets',      color: CHART.positive },
  { key: 'liabilities', label: 'Liabilities', color: CHART.negative },
  { key: 'net',         label: 'Net worth',   color: CHART.accent   },
];

export function NetWorth() {
  const { navigate } = useNav();
  const [view, setView] = useState<'accounts' | 'types'>('accounts');
  const [range, setRange] = useState<NetWorthGranularity>('month');
  const [hiddenSeries, setHiddenSeries] = useState<Set<SeriesKey>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);

  useScreenKeys({
    Tab: () => setView((v) => (v === 'accounts' ? 'types' : 'accounts')),
    r: () => setRange((r) => NW_RANGES[(NW_RANGES.indexOf(r) + 1) % NW_RANGES.length]),
    Escape: () => navigate('dashboard'),
  });

  const balances = useQuery(() => api.queries.getAccountsWithBalances(), []);
  const filterKey = selectedIds ? [...selectedIds].sort().join(',') : '';
  const history = useQuery(
    () => api.queries.getNetWorthHistory(range, selectedIds ? [...selectedIds] : undefined),
    [range, filterKey],
  );

  const accounts = balances?.accounts ?? [];
  const included = accounts.filter((a) => !a.excluded);
  const excluded = accounts.filter((a) => a.excluded);

  const assets = included.filter(isAssetAccount);
  const liabilities = included.filter(isLiabilityAccount);

  const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const netWorth = totalAssets - totalLiabilities;

  const exclNet =
    excluded.filter(isAssetAccount).reduce((s, a) => s + a.balance, 0) -
    excluded.filter(isLiabilityAccount).reduce((s, a) => s + a.balance, 0);

  const chartData = (history ?? []).map((r) => ({
    label: periodLabel(r.period, range),
    assets: r.assets,
    liabilities: -Math.abs(r.liabilities),
    net: r.net_worth,
  }));

  const typeToIds = buildTypeToIds(included);

  function toggleSeries(key: SeriesKey) {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAccount(id: string) {
    setSelectedIds((prev) => {
      if (prev === null) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next.size === 0 ? null : next;
      }
      next.add(id);
      return next;
    });
  }

  function toggleType(label: string) {
    const ids = typeToIds.get(label) ?? [];
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      if (prev === null) return new Set(ids);
      const next = new Set(prev);
      const allIn = ids.every((id) => next.has(id));
      if (allIn) {
        ids.forEach((id) => next.delete(id));
        return next.size === 0 ? null : next;
      }
      ids.forEach((id) => next.add(id));
      return next;
    });
  }

  const isFiltered = selectedIds !== null;
  const anyFilterActive = isFiltered || hiddenSeries.size > 0;
  const totalIncluded = included.length;

  function resetAll() {
    setSelectedIds(null);
    setHiddenSeries(new Set());
  }

  function typeInChart(label: string): boolean {
    return !isFiltered || (typeToIds.get(label)?.some((id) => selectedIds!.has(id)) ?? false);
  }

  function renderDot(inChart: boolean) {
    if (!isFiltered) return <span className={styles.dotDefault}>●</span>;
    return inChart
      ? <span className={styles.dotIn}>●</span>
      : <span className={styles.dotOut}>○</span>;
  }

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [tab] group by type   [r] range   [esc] back" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Net Worth</h1>
        <span className={`num ${netWorth >= 0 ? 'pos' : 'neg'} ${styles.bigNumber}`}>{fmtSigned(netWorth)}</span>
      </div>

      {accounts.length === 0 ? (
        <p className="dim">No balance data yet — sync your accounts to populate.</p>
      ) : (
        <>
          {chartData.length > 0 && (
            <section className={`${styles.panel} ${anyFilterActive ? styles.panelFiltered : ''}`}>
              <div className={styles.panelHeader}>
                <h2>History</h2>
                <div className={styles.rangePills}>
                  {NW_RANGES.map((r) => (
                    <button key={r} className={r === range ? styles.pillActive : styles.pill} onClick={() => setRange(r)}>
                      {NW_RANGE_LABELS[r]}
                    </button>
                  ))}
                  {anyFilterActive && (
                    <button className={styles.resetAllBtn} onClick={resetAll}>Reset</button>
                  )}
                </div>
              </div>
              <div className={styles.seriesRow}>
                {SERIES.map(({ key, label, color }) => (
                  <button
                    key={key}
                    className={hiddenSeries.has(key) ? styles.seriesPillHidden : styles.seriesPill}
                    style={hiddenSeries.has(key) ? undefined : { borderColor: color, color }}
                    onClick={() => toggleSeries(key)}
                  >
                    {label}
                  </button>
                ))}
                {isFiltered && (
                  <span className={styles.filterNote}>
                    {selectedIds!.size} of {totalIncluded} account{totalIncluded !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData}>
                  <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" stroke={CHART.axis} tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis stroke={CHART.axis} tick={{ fontSize: 12 }} tickFormatter={(v: number) => fmtCompact(v)} width={80} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelStyle={tooltipLabelStyle}
                    formatter={(value, name) => [fmt(Number(value)), String(name)]}
                  />
                  <ReferenceLine y={0} stroke={CHART.axis} />
                  {!hiddenSeries.has('assets') && (
                    <Area type="monotone" dataKey="assets" name="Assets" stroke={CHART.positive} fill={CHART.positive} fillOpacity={0.15} strokeWidth={1.5} />
                  )}
                  {!hiddenSeries.has('liabilities') && (
                    <Area type="monotone" dataKey="liabilities" name="Liabilities" stroke={CHART.negative} fill={CHART.negative} fillOpacity={0.15} strokeWidth={1.5} />
                  )}
                  {!hiddenSeries.has('net') && (
                    <Line type="monotone" dataKey="net" name="Net worth" stroke={CHART.accent} dot={false} strokeWidth={2.5} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </section>
          )}

          <div className={styles.columns}>
            {/* Assets */}
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className="pos">Assets</h2>
                <button className={styles.toggleBtn} onClick={() => setView((v) => (v === 'accounts' ? 'types' : 'accounts'))}>
                  {view === 'accounts' ? 'group by type' : 'show accounts'}
                </button>
              </div>
              <table className={styles.table}>
                <tbody>
                  {view === 'accounts'
                    ? assets.map((a) => {
                        const inChart = !isFiltered || selectedIds!.has(a.id);
                        return (
                          <tr
                            key={a.id}
                            className={`${styles.accountRow} ${isFiltered && inChart ? styles.accountRowSelected : ''} ${isFiltered && !inChart ? 'dim' : ''}`}
                            onClick={() => toggleAccount(a.id)}
                          >
                            <td className={styles.tdDot}>{renderDot(inChart)}</td>
                            <td className={styles.tdName}>{a.nickname ?? a.name}</td>
                            <td className="num">{fmt(a.balance)}</td>
                            <td className={`dim ${styles.tdSub}`}>{SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type)}</td>
                          </tr>
                        );
                      })
                    : groupByType(assets).map((t) => {
                        const inChart = typeInChart(t.label);
                        return (
                          <tr
                            key={t.label}
                            className={`${styles.accountRow} ${isFiltered && inChart ? styles.accountRowSelected : ''} ${isFiltered && !inChart ? 'dim' : ''}`}
                            onClick={() => toggleType(t.label)}
                          >
                            <td className={styles.tdDot}>{renderDot(inChart)}</td>
                            <td className={styles.tdName}>{t.label}</td>
                            <td className="num">{fmt(t.balance)}</td>
                            <td />
                          </tr>
                        );
                      })}
                  <tr className={styles.totalRow}>
                    <td />
                    <td className={styles.tdName}>Total assets</td>
                    <td className="num pos">{fmt(totalAssets)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </section>

            {/* Liabilities */}
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className="neg">Liabilities</h2>
              </div>
              {liabilities.length === 0 ? (
                <p className="dim">None — debt free.</p>
              ) : (
                <table className={styles.table}>
                  <tbody>
                    {view === 'accounts'
                      ? liabilities.map((a) => {
                          const inChart = !isFiltered || selectedIds!.has(a.id);
                          return (
                            <tr
                              key={a.id}
                              className={`${styles.accountRow} ${isFiltered && inChart ? styles.accountRowSelected : ''} ${isFiltered && !inChart ? 'dim' : ''}`}
                              onClick={() => toggleAccount(a.id)}
                            >
                              <td className={styles.tdDot}>{renderDot(inChart)}</td>
                              <td className={styles.tdName}>{a.nickname ?? a.name}</td>
                              <td className="num">{fmt(a.balance)}</td>
                            </tr>
                          );
                        })
                      : groupByType(liabilities).map((t) => {
                          const inChart = typeInChart(t.label);
                          return (
                            <tr
                              key={t.label}
                              className={`${styles.accountRow} ${isFiltered && inChart ? styles.accountRowSelected : ''} ${isFiltered && !inChart ? 'dim' : ''}`}
                              onClick={() => toggleType(t.label)}
                            >
                              <td className={styles.tdDot}>{renderDot(inChart)}</td>
                              <td className={styles.tdName}>{t.label}</td>
                              <td className="num">{fmt(t.balance)}</td>
                            </tr>
                          );
                        })}
                    <tr className={styles.totalRow}>
                      <td />
                      <td className={styles.tdName}>Total debt</td>
                      <td className="num neg">{fmt(totalLiabilities)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </section>
          </div>

          {excluded.length > 0 && (
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className="dim">Excluded (not in net worth)</h2>
              </div>
              <table className={styles.table}>
                <tbody>
                  {excluded.map((a) => (
                    <tr key={a.id} className="dim">
                      <td className={styles.tdName}>{a.nickname ?? a.name}</td>
                      <td className="num">{fmt(a.balance)}</td>
                      <td className={`dim ${styles.tdSub}`}>{SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type)}</td>
                    </tr>
                  ))}
                  <tr className={styles.totalRow}>
                    <td className={styles.tdName}>Excluded total</td>
                    <td className="num dim">{fmtSigned(exclNet)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
