import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { fmt, fmtPct, fmtMonths, fmtCompact } from '../../../../core/fmt.js';
import { computeSavingsRate } from '../../../../core/savings-rate.js';
import { KeyHints } from '../components/KeyHints.js';
import { DialRow } from '../components/DialRow.js';
import styles from './Health.module.css';

const DEFAULT_WITHDRAWAL = 4.0;
const DEFAULT_GROWTH = 7.0;
const SPEND_STEP = 100;
const WITHDRAWAL_STEP = 0.5;
const GROWTH_STEP = 1.0;

function savingsRateClass(rate: number): string {
  if (rate < 0) return 'neg';
  if (rate < 10) return 'warn';
  if (rate < 20) return '';
  return 'pos';
}

function runwayClass(months: number, green: number, yellow: number): string {
  if (months >= green) return 'pos';
  if (months >= yellow) return 'warn';
  return 'neg';
}

function roundToStep(n: number): number {
  return Math.round(n / SPEND_STEP) * SPEND_STEP;
}

export function Health() {
  const data = useQuery(() => api.health.loadHealthData(), []);

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

  const annualSpend = spend * 12;
  const fireNumber = annualSpend / (withdrawal / 100);

  const [years, setYears] = useState<number | null>(null);
  const [coast, setCoast] = useState<number | null>(null);
  useEffect(() => {
    if (!data) return;
    void api.health.yearsToFire(data.netWorth, savings + pretax, fireNumber, growth).then(setYears);
    void api.health.coastYears(data.netWorth, fireNumber, growth).then(setCoast);
  }, [data, savings, pretax, fireNumber, growth]);

  if (!data) return <p className="dim">Loading…</p>;

  const cashMonths = spend > 0 ? data.cash / spend : 0;
  const liquidMonths = spend > 0 ? data.liquid / spend : 0;
  const fireProgress = fireNumber > 0 ? Math.max(0, data.netWorth) / fireNumber : 0;
  const grossIncome = data.monthlyIncome + pretax;
  const savingsRate = computeSavingsRate(data.monthlyIncome, savings, pretax);
  const rawSavingsRate = computeSavingsRate(data.monthlyIncome, savings, 0);
  const netCash = data.cash - data.totalDebt;
  const remainingDebt = Math.max(0, data.totalDebt - data.cash);
  const debtMonths = savings > 0 ? remainingDebt / savings : null;
  const combinedDebt = data.totalDebt + data.loanDebt;
  const hasLoanDebt = data.loanDebt > 0;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens" />
      <h1 className={styles.title}>Financial Health</h1>

      {/* Three-number summary — the whole story at a glance */}
      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Savings Rate</div>
          {savingsRate === null ? (
            <div className={`dim ${styles.cardValue}`}>—</div>
          ) : (
            <div className={`num ${savingsRateClass(savingsRate)} ${styles.cardValue}`}>{fmtPct(savingsRate)}</div>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Net Worth</div>
          <div className={`num ${data.netWorth >= 0 ? 'pos' : 'neg'} ${styles.cardValue}`}>{fmtCompact(data.netWorth)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Years to FIRE</div>
          <div className={`num ${years === null ? 'warn' : years === 0 ? 'pos' : 'accent'} ${styles.cardValue}`}>
            {years === null ? '100+ yr' : years === 0 ? 'Now!' : `~${Math.ceil(years)} yr`}
          </div>
        </div>
      </div>

      {/* Cash Flow + Retirement detail */}
      <div className={styles.twoCol}>
        <section className={`${styles.panel} ${styles.panelFlex}`}>
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
              <span className="dim">—</span>
            ) : (
              <span className={`num ${savingsRateClass(savingsRate)} ${styles.metricValue}`}>{fmtPct(savingsRate)}</span>
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
            <span className={`num ${runwayClass(cashMonths, 6, 3)} ${styles.metricValue}`}>{fmtMonths(cashMonths)}</span>
            <span className={`dim ${styles.metricHint}`}>{fmtCompact(data.cash)} in checking/savings</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Liquid runway</span>
            <span className={`num ${runwayClass(liquidMonths, 12, 6)} ${styles.metricValue}`}>{fmtMonths(liquidMonths)}</span>
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
                <span className={`num ${debtMonths <= 6 ? 'pos' : debtMonths <= 24 ? 'warn' : ''} ${styles.metricValue}`}>
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

        <section className={`${styles.panel} ${styles.panelFlex}`}>
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
