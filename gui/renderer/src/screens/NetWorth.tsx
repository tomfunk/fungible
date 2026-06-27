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
  Legend,
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

export function NetWorth() {
  const { navigate } = useNav();
  const [view, setView] = useState<'accounts' | 'types'>('accounts');
  const [range, setRange] = useState<NetWorthGranularity>('month');

  useScreenKeys({
    Tab: () => setView((v) => (v === 'accounts' ? 'types' : 'accounts')),
    r: () => setRange((r) => NW_RANGES[(NW_RANGES.indexOf(r) + 1) % NW_RANGES.length]),
    Escape: () => navigate('dashboard'),
  });

  const balances = useQuery(() => api.queries.getAccountsWithBalances(), []);
  const history = useQuery(() => api.queries.getNetWorthHistory(range), [range]);

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
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>History</h2>
                <div className={styles.rangePills}>
                  {NW_RANGES.map((r) => (
                    <button key={r} className={r === range ? styles.pillActive : styles.pill} onClick={() => setRange(r)}>
                      {NW_RANGE_LABELS[r]}
                    </button>
                  ))}
                </div>
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
                  <Legend />
                  <ReferenceLine y={0} stroke={CHART.axis} />
                  <Area type="monotone" dataKey="assets" name="Assets" stroke={CHART.positive} fill={CHART.positive} fillOpacity={0.15} strokeWidth={1.5} />
                  <Area type="monotone" dataKey="liabilities" name="Liabilities" stroke={CHART.negative} fill={CHART.negative} fillOpacity={0.15} strokeWidth={1.5} />
                  <Line type="monotone" dataKey="net" name="Net worth" stroke={CHART.accent} dot={false} strokeWidth={2.5} />
                </ComposedChart>
              </ResponsiveContainer>
            </section>
          )}

          <div className={styles.columns}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className="pos">Assets</h2>
                <button className={styles.toggleBtn} onClick={() => setView((v) => (v === 'accounts' ? 'types' : 'accounts'))}>
                  {view === 'accounts' ? 'group by type' : 'show accounts'}
                </button>
              </div>
              <table className={styles.table}>
                <tbody>
                  {(view === 'accounts'
                    ? assets.map((a) => ({
                        key: a.name + a.balance,
                        label: a.nickname ?? a.name,
                        balance: a.balance,
                        sub: SUBTYPE_DISPLAY[a.subtype ?? a.type] ?? (a.subtype ?? a.type),
                      }))
                    : groupByType(assets).map((t) => ({ key: t.label, label: t.label, balance: t.balance, sub: '' }))
                  ).map((row) => (
                    <tr key={row.key}>
                      <td className={styles.tdName}>{row.label}</td>
                      <td className="num">{fmt(row.balance)}</td>
                      <td className={`dim ${styles.tdSub}`}>{row.sub}</td>
                    </tr>
                  ))}
                  <tr className={styles.totalRow}>
                    <td className={styles.tdName}>Total assets</td>
                    <td className="num pos">{fmt(totalAssets)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2 className="neg">Liabilities</h2>
              </div>
              {liabilities.length === 0 ? (
                <p className="dim">None — debt free.</p>
              ) : (
                <table className={styles.table}>
                  <tbody>
                    {(view === 'accounts'
                      ? liabilities.map((a) => ({ key: a.name + a.balance, label: a.nickname ?? a.name, balance: a.balance }))
                      : groupByType(liabilities).map((t) => ({ key: t.label, label: t.label, balance: t.balance }))
                    ).map((row) => (
                      <tr key={row.key}>
                        <td className={styles.tdName}>{row.label}</td>
                        <td className="num">{fmt(row.balance)}</td>
                      </tr>
                    ))}
                    <tr className={styles.totalRow}>
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
                    <tr key={a.name + a.balance} className="dim">
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
