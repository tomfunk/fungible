/**
 * Structured personal finance knowledge base for the fungible agent.
 * Opinionated, practical guidance organized by topic.
 *
 * Philosophy: evidence-based, index-fund-first, debt-averse above ~5%,
 * tax-advantaged accounts before taxable. Based on the widely-used
 * personal finance priority flowchart.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type GuideTopic =
  | 'priorities'
  | 'emergency-fund'
  | 'debt'
  | 'employer-match'
  | 'hsa'
  | 'ira'
  | '401k'
  | 'investing'
  | 'budgeting'
  | 'fire'
  | 'housing'
  | 'car'
  | 'insurance';

export type GuideSection = {
  topic: GuideTopic;
  title: string;
  summary: string;
  detail: string;
  rules_of_thumb: string[];
  watch_outs: string[];
};

// ─── Knowledge Base ───────────────────────────────────────────────────────────

const GUIDE: GuideSection[] = [
  {
    topic: 'priorities',
    title: 'The Priority Waterfall',
    summary: 'Do these steps in order. Complete each before moving to the next. This order maximizes guaranteed returns and minimizes risk.',
    detail: `
The order matters because some steps have guaranteed or very high returns:

1. COVER BASICS — Essential expenses paid, no imminent financial crisis.

2. STARTER EMERGENCY FUND — $1,000–2,000 in a HYSA. Not for investing. Prevents small emergencies from becoming debt spirals.

3. EMPLOYER 401k MATCH — Contribute enough to get the full employer match. A 50% match is a guaranteed 50% return — nothing beats it. Do this before paying down most debt.

4. HIGH-INTEREST DEBT — Pay off anything above ~6–7% (credit cards, personal loans, payday loans). The guaranteed return from eliminating 20% APR debt beats any investment.

5. FULL EMERGENCY FUND — 3–6 months of essential expenses in a HYSA. More if income is variable or job market is tough. Liquid, boring, not invested.

6. HSA (if eligible) — Triple tax advantage: pre-tax contributions, tax-free growth, tax-free withdrawals for medical. Max it. Invest the balance, save receipts for later reimbursement.

7. IRA — Max your IRA ($7,000/yr in 2024, $8,000 if 50+). Roth if income is eligible; Traditional if not or if you want the deduction. Roth is usually better long-term.

8. 401k BEYOND MATCH — Max the rest of your 401k ($23,000/yr in 2024). Traditional vs Roth depends on your tax bracket.

9. MEDIUM-INTEREST DEBT (~3–6%) — Judgment call. Guaranteed return vs expected market returns (~7%). Paying down is risk-free; investing is not.

10. TAXABLE INVESTING — Brokerage account, index funds. No contribution limits.

11. LOW-INTEREST DEBT (<3%) — Mathematically better to invest. Psychologically, pay it down if debt bothers you.
    `.trim(),
    rules_of_thumb: [
      'Employer match first, always — it\'s a guaranteed 50–100% return',
      'High-interest debt (>6–7%) is a guaranteed return — prioritize it',
      'Emergency fund before investing beyond the match',
      'HSA > IRA > 401k for tax efficiency (if HSA-eligible)',
      'Roth IRA when young or in lower tax bracket; Traditional when income is high',
    ],
    watch_outs: [
      'Don\'t invest in taxable accounts while carrying credit card debt',
      'Don\'t skip the employer match to pay down low-interest debt',
      'Don\'t count your 401k as your emergency fund — it\'s illiquid and has penalties',
      'Don\'t open a brokerage before maxing tax-advantaged accounts (unless past the limits)',
    ],
  },

  {
    topic: 'emergency-fund',
    title: 'Emergency Fund',
    summary: 'Cash buffer for the unexpected. Not an investment. The goal is stability, not returns.',
    detail: `
An emergency fund is money you can access immediately without penalty, used only for genuine emergencies (job loss, medical, major repair). It is NOT:
- An investment vehicle
- Money for planned purchases
- Money for irregular-but-predictable expenses (car registration, annual subscriptions)

SIZE: 3–6 months of essential expenses (rent/mortgage, utilities, groceries, minimum debt payments, insurance). Use 6+ months if:
- Your income is variable or freelance
- Your industry has long average unemployment duration
- You are the sole earner for dependents
- Your job market is specialized/thin

WHERE: High-yield savings account (HYSA). Current HYSAs pay 4–5% APY. Do NOT put it in a brokerage — the market could drop 30% the day you need it.

STARTER FUND: $1,000–2,000 before tackling high-interest debt. Prevents you from going back into debt for small emergencies.
    `.trim(),
    rules_of_thumb: [
      '3 months if stable salaried job, dual income, no dependents',
      '6 months if variable income, single income household, or specialized career',
      'HYSA only — no investment risk on emergency money',
      'Replenish immediately after using it',
    ],
    watch_outs: [
      'Don\'t invest the emergency fund to "make it work harder" — liquidity and stability are the point',
      'Don\'t use it for planned expenses — budget those separately',
      'Don\'t count equity or retirement accounts in your emergency fund calculation',
    ],
  },

  {
    topic: 'debt',
    title: 'Debt Payoff Strategy',
    summary: 'Not all debt is equal. High-interest debt is a financial emergency. Low-interest debt may be worth keeping.',
    detail: `
CATEGORIZING DEBT BY INTEREST RATE:

HIGH (>7%): Credit cards, payday loans, personal loans, some private student loans.
→ Pay these off aggressively after getting the employer match and a starter emergency fund.
→ No reasonable investment reliably beats a guaranteed 20% return from eliminating CC debt.

MEDIUM (3–7%): Some student loans, car loans, older mortgages.
→ Judgment call. After maxing tax-advantaged accounts, compare guaranteed return (paying it down) vs expected market return (~7%, but volatile). Paying down provides peace of mind and guaranteed return.

LOW (<3%): Many mortgages, subsidized student loans.
→ Mathematically better to invest. The market historically returns ~7% real. Keep the low-rate debt and invest the difference.

PAYOFF METHODS:
- Avalanche (mathematically optimal): Pay minimums on all, throw extra at highest rate. Minimizes total interest paid.
- Snowball (psychologically helpful): Pay minimums on all, attack smallest balance first. Builds momentum. Costs more in interest but keeps people on track.

Recommendation: Use avalanche unless you need the psychological wins to stay motivated.

DEBT CONSOLIDATION: Can make sense if it meaningfully lowers your rate. Watch out for extended terms that increase total interest paid even at a lower rate.
    `.trim(),
    rules_of_thumb: [
      'Above ~7%: pay it off before any non-matched investing',
      '3–7%: pay off after maxing tax-advantaged accounts',
      'Below ~3%: probably invest instead, mathematically',
      'Avalanche saves the most money; snowball keeps people motivated',
      'Minimum payments on everything, then attack your target debt',
    ],
    watch_outs: [
      'Balance transfer cards: only useful if you can pay it off in the 0% promo period',
      'Debt consolidation that extends your term can cost more total even at a lower rate',
      'Don\'t close old credit cards after paying them off — it hurts your credit utilization',
      'Watch for prepayment penalties on personal loans',
    ],
  },

  {
    topic: 'employer-match',
    title: 'Employer 401k Match',
    summary: 'Free money. Always capture the full match before doing anything else with investable income (except a starter emergency fund).',
    detail: `
An employer match is a guaranteed, immediate 50–100% return on your contribution. No investment beats this.

COMMON STRUCTURES:
- "100% match up to 3% of salary" → Contribute 3%, get 3% free = effectively 6% of salary going in.
- "50% match up to 6% of salary" → Contribute 6%, get 3% free.
- "50% match up to 3% of salary" → Contribute 3%, get 1.5% free.

Always contribute at least enough to capture the full match. This is step 3 in the priority waterfall, before most debt payoff.

VESTING: Many employers have a vesting schedule (cliff or graded). If you leave before the schedule completes, you may forfeit some or all of the employer contributions. Check your plan documents.

CONTRIBUTION LIMITS (2024): $23,000 employee contribution, $69,000 total (including employer). If 50+, add $7,500 catch-up.
    `.trim(),
    rules_of_thumb: [
      'Contribute at least enough to capture the full employer match — always',
      'This beats paying down medium/low-interest debt',
      'Check your vesting schedule before quitting',
    ],
    watch_outs: [
      'Some plans have a 1-year waiting period before you can contribute — enroll as soon as eligible',
      'Match is often based on each paycheck, not annual total — front-loading contributions can cause you to miss match if you hit the annual limit early',
      'Poor investment options in your 401k still beat not capturing the match',
    ],
  },

  {
    topic: 'hsa',
    title: 'Health Savings Account (HSA)',
    summary: 'The best tax-advantaged account available. Triple tax benefit. Invest it. Save receipts.',
    detail: `
HSA is available only if you have a High-Deductible Health Plan (HDHP). If you do, max it.

TRIPLE TAX ADVANTAGE:
1. Contributions are pre-tax (or deductible if post-tax)
2. Growth is tax-free
3. Withdrawals for qualified medical expenses are tax-free

After age 65, you can withdraw for ANY reason (like a Traditional IRA) — just pay income tax.

STRATEGY: Pay medical expenses out-of-pocket if you can, invest the HSA balance, and save all receipts. You can reimburse yourself years later with no time limit — tax-free growth for decades, then tax-free withdrawal.

LIMITS (2024): $4,150 individual / $8,300 family. Contributions from employer count toward the limit.

PORTABILITY: HSA is yours. It follows you when you change jobs or insurance.
    `.trim(),
    rules_of_thumb: [
      'Max the HSA if you have an HDHP — it\'s better than IRA for most people',
      'Invest the balance; keep only a small liquid buffer for near-term medical costs',
      'Save every medical receipt — future reimbursements can be tax-free cash',
    ],
    watch_outs: [
      'Only eligible with an HDHP — check before contributing',
      'FSA and HSA are generally not compatible (except limited-purpose FSA)',
      'HDHP may not be optimal if you have high expected medical costs — model it',
    ],
  },

  {
    topic: 'ira',
    title: 'IRA (Individual Retirement Account)',
    summary: 'Max it annually. Roth if income allows. Traditional otherwise. Invest in index funds.',
    detail: `
IRA TYPES:
- ROTH IRA: Contribute after-tax dollars. Growth and withdrawals are tax-free. No RMDs. Backdoor Roth available at high incomes.
- TRADITIONAL IRA: Contribute pre-tax (if deductible). Growth is tax-deferred. Pay tax on withdrawal. Subject to RMDs at 73.

ROTH VS TRADITIONAL — the core question: will your tax rate be higher now or in retirement?
- Lower income now? → Roth (pay tax now at low rate, grow tax-free)
- Higher income now? → Traditional (deduct now at high rate, pay later)
- Young + low income = almost always Roth
- High earner = may prefer Traditional, or Backdoor Roth

ROTH INCOME LIMITS (2024): Phase out $146,000–$161,000 single, $230,000–$240,000 MFJ. Above limits, use Backdoor Roth.

BACKDOOR ROTH: Contribute to Traditional IRA (non-deductible) then convert to Roth. Watch out for pro-rata rule if you have other Traditional IRA balances.

LIMITS (2024): $7,000/yr, $8,000 if 50+.

WHERE TO OPEN: Fidelity, Vanguard, Schwab. All offer excellent low-cost index funds.

WHAT TO INVEST IN:
- Three-fund portfolio: US total market (VTI), international (VXUS), bonds (BND)
- Or a target-date fund for a set-and-forget approach
    `.trim(),
    rules_of_thumb: [
      'Max the IRA every year ($7,000 in 2024)',
      'Roth IRA when young or in lower brackets; Traditional when income is high',
      'Invest in total-market index funds, not individual stocks',
      'Open at Fidelity/Vanguard/Schwab — not a bank or brokerage with high fees',
    ],
    watch_outs: [
      'Contribute to the correct year\'s limit before April tax deadline',
      'Over-contributing is penalized 6%/yr — track carefully',
      'Roth IRA earnings can\'t be withdrawn penalty-free until 59½ (contributions can be)',
      'The pro-rata rule bites you if you do Backdoor Roth with existing Traditional IRA balances',
    ],
  },

  {
    topic: '401k',
    title: '401k (Beyond the Match)',
    summary: 'After the match, IRA, and HSA: max the 401k. High limit, tax deferral, possibly Roth option.',
    detail: `
After you\'ve captured the employer match (step 3), come back to max the 401k after maxing HSA and IRA (steps 6–7).

LIMITS (2024): $23,000 employee contribution. $69,000 total with employer match. $7,500 catch-up if 50+.

TRADITIONAL VS ROTH 401k — same logic as IRA: lower income = prefer Roth; higher income = prefer Traditional.

INVESTMENT OPTIONS: Often limited by what your employer offers. Prioritize:
1. Lowest-expense-ratio index funds (S&P 500, total market)
2. Avoid actively managed funds (higher fees, rarely outperform)
3. Target-date funds are fine for simplicity

IN-SERVICE ROLLOVER: Some plans let you roll funds to an IRA while still employed. Check your plan.

AFTER LEAVING A JOB: Roll your 401k to an IRA at Fidelity/Vanguard/Schwab. More investment options, lower fees, easier to manage.
    `.trim(),
    rules_of_thumb: [
      'Max the 401k after HSA and IRA are maxed',
      'Pick the lowest-fee index funds available in your plan',
      'Roll old 401ks into a single IRA when you change jobs',
    ],
    watch_outs: [
      'High expense ratios (>0.5%) significantly drag long-term returns',
      'Front-loading contributions may cause you to miss some employer match payments — check your plan',
      'Early withdrawal (before 59½) has 10% penalty + income tax',
    ],
  },

  {
    topic: 'investing',
    title: 'Investing Principles',
    summary: 'Index funds. Low cost. Diversified. Long time horizon. Stay the course.',
    detail: `
CORE PRINCIPLES:
1. TIME IN MARKET > TIMING THE MARKET — every year in the market compounds. Don\'t try to pick the right time to invest.
2. DIVERSIFICATION — total market index funds own thousands of companies. No single company failure matters.
3. LOW COST — expense ratios compound against you. A 1% expense ratio over 30 years destroys ~25% of your ending balance vs a 0.03% fund.
4. STAY THE COURSE — markets drop. Expected drops of 30–50% happen occasionally. Selling in a crash locks in losses and misses the recovery.

THE THREE-FUND PORTFOLIO:
- US Total Market (VTI, FSKAX, SWTSX) — ~60%
- International Developed + Emerging (VXUS, FTIHX) — ~30%
- Bonds (BND, FXNAX) — ~10% (adjust based on time horizon / risk tolerance)

ALTERNATIVES:
- Target-date fund (e.g., Vanguard Target Retirement 2055) — all-in-one, auto-rebalances. Slightly higher ER but truly hands-off.
- S&P 500 only (VOO, FXAIX) — fine, just less diversified internationally.

WHAT TO AVOID:
- Individual stocks (undiversified, you\'re competing with professionals)
- Actively managed funds (higher cost, 80%+ underperform their benchmark over 15 years)
- Crypto as a core holding (speculative, high volatility)
- Leveraged or inverse ETFs (not for long-term investing)
- Annuities inside IRAs (pay a fee for a benefit that already exists)
    `.trim(),
    rules_of_thumb: [
      'Expense ratio < 0.1% for index funds; < 0.2% for target-date funds',
      'Invest in total market index funds, not individual stocks',
      'Don\'t sell during market downturns — volatility is the cost of long-term returns',
      'Automate contributions so you don\'t try to time the market',
    ],
    watch_outs: [
      'Past performance does not predict future performance (especially for active funds)',
      'Chasing last year\'s best-performing fund is a well-documented way to underperform',
      '"Hot" sectors (tech, AI, etc.) often mean the gains are already priced in',
    ],
  },

  {
    topic: 'budgeting',
    title: 'Budgeting',
    summary: 'Know where your money goes. Spend intentionally. Automate the important stuff.',
    detail: `
FRAMEWORKS:

50/30/20:
- 50% needs (housing, utilities, groceries, minimum debt payments, insurance)
- 30% wants (dining, entertainment, subscriptions, shopping)
- 20% savings and extra debt payoff

This is a guideline, not a law. High cost-of-living cities often require adjusting.

ZERO-BASED BUDGETING:
Assign every dollar a job. Income minus all assigned categories = $0. More deliberate, more work.

PAY YOURSELF FIRST:
Automate savings contributions on payday before spending anything. Treats savings as non-optional.

IRREGULAR EXPENSES:
Budget monthly for annual expenses (car registration, insurance, gifts, vacations). Divide the annual cost by 12 and set that aside monthly.

CATEGORIES TO WATCH IN FUNGIBLE:
- Food & Drink: often highest discretionary category; easy to trim
- Subscriptions: recurring charges that accumulate invisibly; audit quarterly
- Shopping: often underestimated because individual purchases feel small
    `.trim(),
    rules_of_thumb: [
      'Housing under 30% of gross income (ideally under 28%)',
      'Transportation (car payment + insurance + gas) under 15% of take-home',
      'Automate savings and investment contributions so they happen before spending',
      'Audit subscriptions quarterly — cancel anything unused for 60+ days',
    ],
    watch_outs: [
      'Lifestyle inflation is silent — spending grows to match income growth without noticing',
      'Small daily spending (coffee, lunch) adds up but is rarely the biggest problem; focus on big-ticket categories first',
      '"I deserve it" spending is fine in moderation but shouldn\'t derail financial priorities',
    ],
  },

  {
    topic: 'fire',
    title: 'FIRE (Financial Independence / Retire Early)',
    summary: 'Accumulate 25x annual expenses. 4% safe withdrawal rate. FIRE number is personal.',
    detail: `
THE MATH:
- FIRE Number = Annual Expenses × 25 (at 4% withdrawal rate)
- 4% Rule: Based on historical data, you can withdraw 4% of your portfolio annually and not run out of money over 30 years with high probability.
- The 4% rule was designed for 30-year retirements. For early retirement (40+ years), consider 3–3.5% withdrawal rate.

VARIANTS:
- Lean FIRE: Retire on minimal spending. High restriction, maximum flexibility on timeline.
- Fat FIRE: Retire with enough to maintain a comfortable lifestyle without frugality.
- Coast FIRE: Save enough that compound growth alone gets you to FIRE number by traditional retirement age — then you only need to cover current expenses.
- Barista FIRE: Semi-retire with part-time work covering some expenses, reducing drawdown.

YEARS TO FIRE:
Determined by your savings rate, not income. Higher income only helps if you maintain a high savings rate.

SAVINGS RATE → APPROX YEARS TO FIRE (at 7% real growth, starting from $0):
- 10% savings rate → ~40 years
- 25% → ~27 years
- 50% → ~17 years
- 75% → ~7 years

THE SEQUENCE-OF-RETURNS RISK:
A major market decline in the first few years of retirement can permanently damage a portfolio. Mitigations: flexible spending, small amount of work income, bond tent, cash buffer.
    `.trim(),
    rules_of_thumb: [
      'FIRE Number = Annual Spending × 25',
      '4% withdrawal rate for 30-year retirement; 3–3.5% for 40+ year early retirement',
      'Savings rate is the primary driver of timeline — income matters less than you think',
      'Net worth in fungible\'s Financial Health screen tracks your FIRE progress',
    ],
    watch_outs: [
      'Healthcare before Medicare eligibility (65) is a major cost — plan for it',
      '401k and IRA have early withdrawal penalties before 59½ — need a Roth conversion ladder or taxable bridge',
      'Sequence of returns risk is highest in the first 5 years of retirement',
      'Inflation erodes real purchasing power — a $100k income today isn\'t $100k in 20 years',
    ],
  },

  {
    topic: 'housing',
    title: 'Housing: Buy vs Rent',
    summary: 'Neither is universally better. Depends on timeline, local market, and opportunity cost.',
    detail: `
BUYING MAKES SENSE WHEN:
- You plan to stay for 5+ years (breaks even on transaction costs)
- Local rent:price ratio is below ~20 (annual rent / home price < 5%)
- You have 20% down payment plus 3–6% for closing costs plus emergency fund intact
- Your housing costs (PITI + maintenance) will be under ~28–30% of gross income

RENTING MAKES SENSE WHEN:
- You might move within 3–5 years
- Local prices are high relative to rent (rent:price > 5%)
- You would need to deplete your emergency fund or invest less to afford it
- The flexibility premium is worth it to you

THE REAL COSTS OF HOMEOWNERSHIP:
- Property taxes (~1–2% of value/yr)
- Insurance (~0.5–1% of value/yr)
- Maintenance (~1–2% of value/yr)
- PMI if <20% down
- Transaction costs (5–6% on sale)

A house is a place to live, not primarily an investment. The "opportunity cost" of the down payment and the illiquidity matter.

THE 28/36 RULE:
- Housing costs ≤ 28% of gross monthly income (front-end ratio)
- All debt payments ≤ 36% of gross monthly income (back-end ratio)
    `.trim(),
    rules_of_thumb: [
      '5+ year horizon before buying makes financial sense',
      '20% down avoids PMI; less is fine with a solid financial position',
      'Budget 1–2% of home value annually for maintenance',
      'PITI ≤ 28% of gross income',
    ],
    watch_outs: [
      'Real estate is illiquid — don\'t count on being able to sell quickly if you need cash',
      'HOA fees can be significant and increase over time',
      'Don\'t deplete your emergency fund for a down payment',
      '"House hacking" (renting rooms/ADU) can dramatically change the math',
    ],
  },

  {
    topic: 'car',
    title: 'Car',
    summary: 'A car is a depreciating asset. Keep total vehicle costs under 15% of take-home pay.',
    detail: `
TOTAL COST OF OWNERSHIP:
- Purchase price (or monthly payment)
- Insurance
- Gas / charging
- Maintenance and repairs
- Registration / taxes
- Depreciation (new cars lose 15–25% of value in year 1)

GUIDELINES:
- Total monthly vehicle costs ≤ 15% of take-home pay
- If buying new: car value ≤ 35–50% of gross annual income (conservative: ≤ 6 months income)
- Buying used (3–5 years old) avoids the steepest depreciation curve

BUY VS LEASE:
- Buy: Better financially if you keep the car long-term (5+ years past payoff)
- Lease: You pay for the most expensive portion (new depreciation), return with nothing. Usually more expensive long-term. Useful if you need low monthly payment and always want a new car.

LOAN STRATEGY:
- Shortest loan term you can comfortably afford (avoid 72–84 month loans)
- Get pre-approved at a credit union before going to dealer
    `.trim(),
    rules_of_thumb: [
      'Total vehicle costs (payment + insurance + gas) under 15% of take-home',
      'Buy used (3–5 years old) to avoid worst depreciation',
      'Loan term under 48–60 months',
      'Never roll negative equity into a new car purchase',
    ],
    watch_outs: [
      'Dealer financing is often worse than credit union — shop rates first',
      'Gap insurance matters if you financed more than the car is worth',
      'Extended warranties are often overpriced — check Consumer Reports reliability ratings instead',
    ],
  },

  {
    topic: 'insurance',
    title: 'Insurance',
    summary: 'Insure against catastrophic risk. Self-insure small risks. Don\'t over-insure.',
    detail: `
CRITICAL INSURANCE:

HEALTH: Non-negotiable. Medical bills are the leading cause of bankruptcy. If employer-sponsored, take it. If HDHP + HSA-eligible, do the math.

DISABILITY: Protects your income — your most valuable asset. Long-term disability insurance replaces 60–70% of income if you can\'t work. Often employer-provided; if not, buy it.

LIFE: Only needed if others depend on your income (children, spouse who doesn\'t work). Term life (20–30 years, 10–12× income). Do NOT buy whole/universal life insurance — it mixes insurance with investment poorly and at high cost.

AUTO: Liability minimums are too low in most states. Carry at least $100k/$300k liability. Drop collision/comprehensive on old cars (value < 10× annual premium).

HOMEOWNERS/RENTERS: Renters insurance is cheap (~$15–25/mo) and protects all your possessions. Required for homeowners with a mortgage.

UMBRELLA: $1–5M liability coverage for ~$200–400/yr. Worth it if you have significant assets.

DON\'T OVER-INSURE:
- Skip extended warranties on low-cost electronics
- Skip credit card insurance / payment protection
- Self-insure small, recoverable losses (that\'s what your emergency fund is for)
    `.trim(),
    rules_of_thumb: [
      'Term life only, never whole/universal life as an investment vehicle',
      '10–12× income for term life coverage',
      'Carry renters insurance even if your landlord doesn\'t require it (~$20/mo)',
      'High deductibles lower premiums — self-insure with your emergency fund',
    ],
    watch_outs: [
      'Whole life and universal life policies have high commissions and poor returns — avoid',
      'State minimum auto liability is almost always too low',
      'Disability insurance is often the most under-purchased coverage',
    ],
  },
];

// ─── Access Functions ─────────────────────────────────────────────────────────

/** Return a specific topic section, or the priority waterfall overview. */
export function getFinanceGuide(topic?: GuideTopic): GuideSection | GuideSection[] {
  if (!topic) return GUIDE;
  return GUIDE.find((s) => s.topic === topic) ?? GUIDE[0];
}

/** Return all topic keys and summaries for a quick overview. */
export function getFinanceTopicList(): { topic: GuideTopic; title: string; summary: string }[] {
  return GUIDE.map(({ topic, title, summary }) => ({ topic, title, summary }));
}

/** Format a single GuideSection as human-readable text for the agent. */
export function formatGuideSection(section: GuideSection): string {
  const lines = [
    `# ${section.title}`,
    '',
    section.summary,
    '',
    section.detail,
    '',
    '## Rules of Thumb',
    ...section.rules_of_thumb.map((r) => `- ${r}`),
    '',
    '## Watch Out For',
    ...section.watch_outs.map((w) => `- ${w}`),
  ];
  return lines.join('\n');
}
