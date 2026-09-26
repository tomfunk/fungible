import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { fmt, fmtPct, fmtMonths, fmtCompact } from '../../../../core/fmt.js';
import { computeSavingsRate } from '../../../../core/savings-rate.js';
import { computeFireRunwayMetrics, savingsRateSeverity, runwaySeverity, debtPayoffSeverity } from '../../../../core/health-metrics.js';
import type { SeverityLevel } from '../../../../core/severity.js';
import type { NetWorthGranularity } from '../../../../core/queries.js';
import { useChartTheme, tooltipStyle, tooltipLabelStyle } from '../components/chartTheme.js';
import { periodLabel } from '../lib/periodLabel.js';
import { KeyHints } from '../components/KeyHints.js';
import { DialRow } from '../components/DialRow.js';
import styles from './Health.module.css';

const DEFAULT_WITHDRAWAL = 4.0;
const DEFAULT_GROWTH = 7.0;
const SPEND_STEP = 100;
const WITHDRAWAL_STEP = 0.5;
const GROWTH_STEP = 1.0;

const HISTORY_RANGES: NetWorthGranularity[] = ['week', 'month', 'quarter', 'year'];
const HISTORY_RANGE_LABELS: Record<NetWorthGranularity, string> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

type HistoryUnit = 'pct' | 'months' | 'dollar' | 'years';
type HistoryMetricKey = 'savingsRate' | 'cashRunway' | 'liquidRunway' | 'debtPayoff' | 'retirement' | 'yearsToFire' | 'coastFire';

const HISTORY_METRICS: { key: HistoryMetricKey; label: string; unit: HistoryUnit }[] = [
  { key: 'savingsRate',  label: 'Savings Rate',  unit: 'pct' },
  { key: 'cashRunway',   label: 'Cash Runway',   unit: 'months' },
  { key: 'liquidRunway', label: 'Liquid Runway', unit: 'months' },
  { key: 'debtPayoff',   label: 'Debt Payoff',   unit: 'months' },
  { key: 'retirement',   label: 'Retirement Balance', unit: 'dollar' },
  { key: 'yearsToFire',  label: 'Years to FIRE', unit: 'years' },
  { key: 'coastFire',    label: 'Coast FIRE',    unit: 'years' },
];

// yearsToFire/coastYears apply *today's* withdrawal-rate/growth-rate dials
// (and today's fireNumber target) to each period's historical net worth --
// they are not a historically-accurate record the way the other metrics are,
// since neither dial is tracked over time. Callers must caption this.
const PROJECTED_METRICS: HistoryMetricKey[] = ['yearsToFire', 'coastFire'];

function formatHistoryValue(value: number | null, unit: HistoryUnit): string {
  if (value === null) return '—';
  switch (unit) {
    case 'pct': return fmtPct(value);
    case 'months': return fmtMonths(value);
    case 'dollar': return fmtCompact(value);
    case 'years': return `${value.toFixed(1)} yr`;
  }
}

// SeverityLevel -> this screen's existing pos/warn/neg/(neutral) class names.
function severityToClass(level: SeverityLevel): string {
  switch (level) {
    case 'good': return 'pos';
    case 'caution': return 'warn';
    case 'bad': return 'neg';
    case 'neutral': return '';
  }
}

function roundToStep(n: number): number {
  return Math.round(n / SPEND_STEP) * SPEND_STEP;
}

export function Health() {
  const data = useQuery(() => api.health.loadHealthData(), []);
  const chartTheme = useChartTheme();

  const [historyRange, setHistoryRange] = useState<NetWorthGranularity>('month');
  const [historyMetric, setHistoryMetric] = useState<HistoryMetricKey>('savingsRate');
  const history = useQuery(() => api.health.getHealthHistory(historyRange), [historyRange]);

  const [monthlySpend, setMonthlySpend] = useState<number | null>(null);
  const [monthlySavings, setMonthlySavings] = useState<number | null>(null);
  const [pretaxSavings, setPretaxSavings] = useState<number | null>(null);
  const [withdrawal, setWithdrawal] = useState(DEFAULT_WITHDRAWAL);
  const [growth, setGrowth] = useState(DEFAULT_GROWTH);

  const pretaxRaw = useQuery(() => api.settings.getPretaxMonthly(), []);
  useEffect(() => {
    if (pretaxRaw !== undefined) setPretaxSavings(pretaxRaw ? roundToStep(parseFloat(pretaxRaw)) : 0);
  }, [pretaxRaw]);

  const defaultSpend = data ? Math.max(SPEND_STEP, roundToStep(data.avgMonthlyExpenses)) : SPEND_STEP;
  const defaultSavings = data ? roundToStep(data.monthlySavings) : 0;
  const spend = monthlySpend ?? defaultSpend;
  const savings = monthlySavings ?? defaultSavings;
  const pretax = pretaxSavings ?? 0;

  const {
    annualSpend, fireNumber, fireProgress,
    cashRunwayMonths: cashMonths, liquidRunwayMonths: liquidMonths,
    netCash, remainingDebt, debtPayoffMonths: debtMonths,
  } = computeFireRunwayMetrics({
    monthlySpend: spend,
    withdrawalRatePct: withdrawal,
    cash: data?.cash ?? 0,
    liquid: data?.liquid ?? 0,
    totalDebt: data?.totalDebt ?? 0,
    monthlySavings: savings,
    netWorth: data?.netWorth ?? 0,
  });

  const [years, setYears] = useState<number | null>(null);
  const [coast, setCoast] = useState<number | null>(null);
  useEffect(() => {
    if (!data) return;
    void api.health.yearsToFire(data.netWorth, savings + pretax, fireNumber, growth).then(setYears);
    void api.health.coastYears(data.netWorth, fireNumber, growth).then(setCoast);
  }, [data, savings, pretax, fireNumber, growth]);

  // yearsToFire/coastYears live in health.ts (DB-adjacent), so they're only
  // reachable through the bridge -- one batched effect projects the whole
  // history array at once (rather than the chart re-triggering N round trips
  // per render), and only while one of those two metrics is selected.
  const [fireHistory, setFireHistory] = useState<{ years: number | null; coast: number | null }[] | null>(null);
  useEffect(() => {
    if (!history || !PROJECTED_METRICS.includes(historyMetric)) return;
    let alive = true;
    void Promise.all(
      history.map((row) => Promise.all([
        api.health.yearsToFire(row.netWorth, row.monthlySavings + pretax, fireNumber, growth),
        api.health.coastYears(row.netWorth, fireNumber, growth),
      ])),
    ).then((pairs) => {
      if (alive) setFireHistory(pairs.map(([y, c]) => ({ years: y, coast: c })));
    });
    return () => { alive = false; };
  }, [history, historyMetric, fireNumber, growth, pretax]);

  const historySelection = HISTORY_METRICS.find((m) => m.key === historyMetric)!;
  const chartData = useMemo(() => {
    if (!history) return [];
    return history.map((row, i) => {
      const label = periodLabel(row.period, historyRange);
      let value: number | null;
      switch (historyMetric) {
        case 'savingsRate':
          value = computeSavingsRate(row.monthlyIncome, row.monthlySavings, pretax);
          break;
        case 'retirement':
          value = row.retirement;
          break;
        case 'yearsToFire':
          value = fireHistory?.[i]?.years ?? null;
          break;
        case 'coastFire':
          value = fireHistory?.[i]?.coast ?? null;
          break;
        default: {
          const m = computeFireRunwayMetrics({
            monthlySpend: row.avgMonthlyExpenses,
            withdrawalRatePct: withdrawal,
            cash: row.cash,
            liquid: row.liquid,
            totalDebt: row.totalDebt,
            monthlySavings: row.monthlySavings,
            netWorth: row.netWorth,
          });
          value = historyMetric === 'cashRunway' ? m.cashRunwayMonths
            : historyMetric === 'liquidRunway' ? m.liquidRunwayMonths
              : m.debtPayoffMonths;
        }
      }
      return { label, value };
    });
  }, [history, historyMetric, historyRange, withdrawal, fireHistory, pretax]);

  if (!data) return <p className="dim">Loading…</p>;

  const grossIncome = data.monthlyIncome + pretax;
  const savingsRate = computeSavingsRate(data.monthlyIncome, savings, pretax);
  const rawSavingsRate = computeSavingsRate(data.monthlyIncome, savings, 0);
  const combinedDebt = data.totalDebt + data.loanDebt;
  const hasLoanDebt = data.loanDebt > 0;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens" />
      <h1 className={styles.title}>Financial Health</h1>

      {/* Three-number summary — the whole story at a glance */}
      <div className="kpiStrip">
        <div className="kpiCell">
          <div className="kpiLabel">Savings Rate</div>
          {savingsRate === null ? (
            <div className="dim kpiFigure">—</div>
          ) : (
            <div className={`num ${severityToClass(savingsRateSeverity(savingsRate))} kpiFigure`}>{fmtPct(savingsRate)}</div>
          )}
        </div>
        <div className="kpiCell">
          <div className="kpiLabel">Net Worth</div>
          <div className={`num kpiFigure ${data.netWorth >= 0 ? 'pos' : 'neg'}`}>{fmtCompact(data.netWorth)}</div>
        </div>
        <div className="kpiCell">
          <div className="kpiLabel">Years to FIRE</div>
          <div className={`num kpiFigure ${years === null ? 'warn' : years === 0 ? 'pos' : 'accent'}`}>
            {years === null ? '100+ yr' : years === 0 ? 'Now!' : `~${Math.ceil(years)} yr`}
          </div>
        </div>
      </div>

      {/* Cash Flow + Retirement detail */}
      <div className={styles.twoCol}>
        <section className={styles.panel}>
          <h2>Cash Flow</h2>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Monthly income</span>
            <span className={`num ${styles.metricValue}`}>{fmt(grossIncome)}</span>
            <span className={`dim ${styles.metricHint}`}>
              12-mo avg{pretax > 0 ? ` · ${fmtCompact(data.monthlyIncome)} take-home` : ''}
            </span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Savings rate</span>
            {savingsRate === null ? (
              <span className={`dim ${styles.metricValue}`}>—</span>
            ) : (
              <span className={`num ${severityToClass(savingsRateSeverity(savingsRate))} ${styles.metricValue}`}>{fmtPct(savingsRate)}</span>
            )}
            <span className={`dim ${styles.metricHint}`}>
              {savingsRate === null
                ? 'no income found in transactions'
                : savingsRate < 0
                  ? 'spending more than earning'
                  : savingsRate < 10
                    ? 'aim for 20%+'
                    : savingsRate < 20
                      ? 'getting there — aim for 20%+'
                      : savingsRate >= 50
                        ? 'FIRE pace'
                        : 'on track'}
              {savingsRate !== null && pretax > 0 && rawSavingsRate !== null
                ? ` · ${fmtPct(rawSavingsRate)} take-home`
                : ''}
            </span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Cash runway</span>
            <span className={`num ${severityToClass(runwaySeverity(cashMonths, 6, 3))} ${styles.metricValue}`}>{fmtMonths(cashMonths)}</span>
            <span className={`dim ${styles.metricHint}`}>{fmtCompact(data.cash)} in checking/savings</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Liquid runway</span>
            <span className={`num ${severityToClass(runwaySeverity(liquidMonths, 12, 6))} ${styles.metricValue}`}>{fmtMonths(liquidMonths)}</span>
            <span className={`dim ${styles.metricHint}`}>{fmtCompact(data.liquid)} incl. brokerage</span>
          </div>
          {combinedDebt > 0 && !hasLoanDebt && (
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Debt</span>
              <span className={`num neg ${styles.metricValue}`}>
                {fmtCompact(data.totalDebt)}
              </span>
              <span className={`dim ${styles.metricHint}`}>
                {netCash >= 0
                  ? `covered · ${fmtCompact(netCash)} net cash`
                  : `${fmtCompact(Math.abs(netCash))} more than cash`}
              </span>
            </div>
          )}
          {hasLoanDebt && (
            <>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Credit cards</span>
                <span className={`num ${data.totalDebt > 0 ? 'neg' : 'dim'} ${styles.metricValue}`}>
                  {fmtCompact(data.totalDebt)}
                </span>
                <span className={`dim ${styles.metricHint}`}>
                  {data.totalDebt === 0
                    ? 'no card balance'
                    : netCash >= 0
                      ? `covered · ${fmtCompact(netCash)} net cash`
                      : `${fmtCompact(Math.abs(netCash))} more than cash`}
                </span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Loans</span>
                <span className={`num neg ${styles.metricValue}`}>
                  {fmtCompact(data.loanDebt)}
                </span>
                <span className={`dim ${styles.metricHint}`}>mortgage / auto / student</span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Total</span>
                <span className={`num neg ${styles.metricValue}`}>
                  {fmtCompact(combinedDebt)}
                </span>
                <span className={`dim ${styles.metricHint}`}>subtracted from net worth</span>
              </div>
            </>
          )}
          {data.totalDebt > 0 && netCash < 0 && (
            <div className={styles.metric}>
              <span className={styles.metricLabel}>Debt-free in</span>
              {debtMonths === null ? (
                <span className={`neg ${styles.metricValue}`}>no surplus</span>
              ) : (
                <span className={`num ${severityToClass(debtPayoffSeverity(debtMonths, 6, 24))} ${styles.metricValue}`}>
                  {fmtMonths(debtMonths)}
                </span>
              )}
              <span className={`dim ${styles.metricHint}`}>
                {debtMonths !== null
                  ? `${fmtCompact(remainingDebt)} remaining after cash`
                  : 'increase savings to pay off debt'}
              </span>
            </div>
          )}
        </section>

        <section className={styles.panel}>
          <h2>Retirement</h2>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Net worth</span>
            <span className={`num ${data.netWorth >= 0 ? 'pos' : 'neg'} ${styles.metricValue}`}>
              {fmtCompact(data.netWorth)}
            </span>
            <span className={`dim ${styles.metricHint}`}>{fmtPct(fireProgress * 100)} of FIRE target</span>
          </div>
          <div className={styles.progressRow}>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${Math.min(100, fireProgress * 100)}%` }} />
            </div>
            <span className="dim" style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>
              {fmtCompact(fireNumber)} target
            </span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>FIRE spend</span>
            <span className={`num ${styles.metricValue}`}>{fmtCompact(annualSpend)}</span>
            <span className={`dim ${styles.metricHint}`}>per year · {withdrawal}% withdrawal</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Coast FIRE</span>
            {coast === null ? (
              <span className={`dim ${styles.metricValue}`}>—</span>
            ) : coast === 0 ? (
              <span className={`pos ${styles.metricValue}`}>Achieved!</span>
            ) : (
              <span className={`accent num ${styles.metricValue}`}>~{Math.ceil(coast)} yr</span>
            )}
            <span className={`dim ${styles.metricHint}`}>
              {coast === null
                ? 'need positive net worth'
                : coast === 0
                  ? 'growth alone covers retirement'
                  : 'if you stop saving now'}
            </span>
          </div>
        </section>
      </div>

      {history && history.length > 0 && (
        <section className={styles.panel}>
          <div className="sectionHead">
            <span className="sectionLabel">History</span>
            <div className={`pillGroup ${styles.rangePills}`}>
              {HISTORY_RANGES.map((r) => (
                <button key={r} className={r === historyRange ? 'pillActive' : 'pill'} onClick={() => setHistoryRange(r)}>
                  {HISTORY_RANGE_LABELS[r]}
                </button>
              ))}
            </div>
          </div>
          <div className={`pillGroup ${styles.metricPills}`}>
            {HISTORY_METRICS.map((m) => (
              <button key={m.key} className={m.key === historyMetric ? 'pillActive' : 'pill'} onClick={() => setHistoryMetric(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          {PROJECTED_METRICS.includes(historyMetric) && (
            <p className={`dim ${styles.historyCaption}`}>
              Using today's growth/withdrawal-rate assumptions applied to past balances — not a historical record.
            </p>
          )}
          <div className={styles.chartFrame}>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData}>
                <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="var(--rule)"
                  tick={{ fontSize: 11, fill: chartTheme.axis, fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  stroke="var(--rule)"
                  tick={{ fontSize: 11, fill: chartTheme.axis, fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  tickFormatter={(v: number) => formatHistoryValue(v, historySelection.unit)}
                  width={70}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={tooltipLabelStyle}
                  formatter={(value) => [formatHistoryValue(value === null ? null : Number(value), historySelection.unit), historySelection.label]}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  name={historySelection.label}
                  stroke={chartTheme.accent}
                  dot={false}
                  strokeWidth={2}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className={styles.panel}>
        <h2>Assumptions</h2>
        <div className={styles.dials}>
          <DialRow
            label="Monthly spending"
            value={spend}
            defaultValue={defaultSpend}
            step={SPEND_STEP}
            min={SPEND_STEP}
            format="dollar"
            hint="avg past 12 months"
            onChange={setMonthlySpend}
            onReset={() => setMonthlySpend(null)}
          />
          <DialRow
            label="Monthly savings"
            value={savings}
            defaultValue={defaultSavings}
            step={SPEND_STEP}
            format="dollar"
            hint="avg surplus past 12 mo"
            onChange={setMonthlySavings}
            onReset={() => setMonthlySavings(null)}
          />
          <DialRow
            label="Pretax savings"
            value={pretax}
            defaultValue={0}
            step={SPEND_STEP}
            min={0}
            format="dollar"
            hint="401k/HSA — not in transactions"
            onChange={(v) => {
              setPretaxSavings(v);
              void api.settings.setPretaxMonthly(String(v));
            }}
            onReset={() => {
              setPretaxSavings(0);
              void api.settings.setPretaxMonthly('0');
            }}
          />
          <DialRow
            label="Withdrawal rate"
            value={withdrawal}
            defaultValue={DEFAULT_WITHDRAWAL}
            step={WITHDRAWAL_STEP}
            min={0.5}
            max={10}
            format="percent"
            hint="safe withdrawal rate"
            onChange={setWithdrawal}
          />
          <DialRow
            label="Growth rate"
            value={growth}
            defaultValue={DEFAULT_GROWTH}
            step={GROWTH_STEP}
            min={0}
            max={20}
            format="percent"
            hint="real annual return"
            onChange={setGrowth}
          />
        </div>
      </section>
    </div>
  );
}
