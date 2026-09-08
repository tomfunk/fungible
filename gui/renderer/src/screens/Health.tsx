import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { fmt, fmtPct, fmtMonths, fmtCompact } from '../../../../core/fmt.js';
import { KeyHints } from '../components/KeyHints.js';
import styles from './Health.module.css';

const DEFAULT_WITHDRAWAL = 4.0;
const DEFAULT_GROWTH = 7.0;
const SPEND_STEP = 100;

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
  const savingsRate = grossIncome > 0 ? ((savings + pretax) / grossIncome) * 100 : null;
  const rawSavingsRate = data.monthlyIncome > 0 ? (savings / data.monthlyIncome) * 100 : null;
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
        <div className={styles.dialsDollar}>
          <DollarDial
            label="Monthly spending"
            value={spend}
            defaultValue={defaultSpend}
            min={SPEND_STEP}
            hint="avg past 12 months"
            onChange={(v) => setMonthlySpend(Math.max(SPEND_STEP, v))}
            onReset={() => setMonthlySpend(null)}
          />
          <DollarDial
            label="Monthly savings"
            value={savings}
            defaultValue={defaultSavings}
            hint="avg surplus past 12 mo"
            signed
            onChange={setMonthlySavings}
            onReset={() => setMonthlySavings(null)}
          />
          <DollarDial
            label="Pretax savings"
            value={pretax}
            defaultValue={0}
            min={0}
            hint="401k/HSA — not in transactions"
            onChange={(v) => {
              setPretaxSavings(Math.max(0, v));
              void api.settings.setPretaxMonthly(String(Math.max(0, v)));
            }}
            onReset={() => {
              setPretaxSavings(0);
              void api.settings.setPretaxMonthly('0');
            }}
          />
        </div>
        <div className={styles.dialsRate}>
          <SliderDial
            label="Withdrawal rate"
            value={withdrawal}
            defaultValue={DEFAULT_WITHDRAWAL}
            min={0.5}
            max={10}
            step={0.5}
            hint="safe withdrawal rate"
            onChange={setWithdrawal}
          />
          <SliderDial
            label="Growth rate"
            value={growth}
            defaultValue={DEFAULT_GROWTH}
            min={0}
            max={20}
            step={0.5}
            hint="real annual return"
            onChange={setGrowth}
          />
        </div>
      </section>
    </div>
  );
}

function DollarDial({
  label,
  value,
  defaultValue,
  min,
  hint,
  signed,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  defaultValue: number;
  min?: number;
  hint: string;
  signed?: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  const changed = value !== defaultValue;
  return (
    <div className={styles.dial}>
      <span className={styles.dialLabel}>{label}</span>
      <div className={styles.dialControls}>
        <button className={styles.stepBtn} onClick={() => onChange(value - SPEND_STEP)}>
          −
        </button>
        <input
          type="number"
          className={styles.dialInput}
          value={value}
          step={SPEND_STEP}
          min={min}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            if (!isNaN(n)) onChange(roundToStep(n));
          }}
        />
        <button className={styles.stepBtn} onClick={() => onChange(value + SPEND_STEP)}>
          +
        </button>
        {changed && (
          <button className={styles.resetBtn} onClick={onReset} title={`Reset to ${fmt(defaultValue, 0)}`}>
            reset
          </button>
        )}
      </div>
      <span className={`dim ${styles.dialHint}`}>
        {hint}
        {changed ? ' (modified)' : ''}
      </span>
    </div>
  );
}

function SliderDial({
  label,
  value,
  defaultValue,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  const changed = value !== defaultValue;
  return (
    <div className={styles.dial}>
      <div className={styles.dialHeader}>
        <span className={styles.dialLabel}>{label}</span>
        <span className={`num ${styles.dialValue}`}>{fmtPct(value)}</span>
      </div>
      <div className={styles.dialControls}>
        <input
          type="range"
          className={styles.slider}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        {changed && (
          <button className={styles.resetBtn} onClick={() => onChange(defaultValue)} title={`Reset to ${fmtPct(defaultValue)}`}>
            reset
          </button>
        )}
      </div>
      <span className={`dim ${styles.dialHint}`}>
        {hint}
        {changed ? ' (modified)' : ''}
      </span>
    </div>
  );
}
