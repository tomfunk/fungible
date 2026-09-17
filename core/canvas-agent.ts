import { streamResponse } from './llm-provider.js';
import { loadHealthData, computeSavingsRate } from './health.js';
import { loadProfile } from './profile.js';
import { fmt, fmtCompact } from './fmt.js';
import { getSetting, PRETAX_MONTHLY_KEY } from './settings.js';
import type { CanvasSpec } from './canvas-spec.js';

// Pure canvas types + evaluator moved to canvas-spec.ts (renderer-safe);
// re-exported here so existing importers keep working.
export * from './canvas-spec.js';

// ─── Dial bindings ──────────────────────────────────────────────────────────────
// Closed vocabulary of live-metric keys a dial's `binding` field may reference.
// Each is sourced from the same functions loadCanvasContext already calls for the
// equivalent LLM-context line, so this inherits the existing loans-as-liabilities
// and 12-month-average fixes rather than reimplementing any arithmetic.

export const BINDING_KEYS = [
  'monthly_income_12mo_avg',
  'monthly_expenses_12mo_avg',
  'monthly_surplus_12mo_avg',
  'cash_balance',
  'taxable_brokerage',
  'liquid_assets',
  'retirement_balance',
  'credit_card_debt',
  'loan_debt',
  'net_worth',
  'savings_rate_pct',
  'self_age',
  'spouse_age',
] as const;

export type BindingKey = typeof BINDING_KEYS[number];

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(financialContext: string): string {
  return `You are a financial canvas generator embedded in fungible, a personal finance TUI app.

Given a user's financial question and their live account data, you generate an interactive canvas — a set of adjustable inputs (dials) and computed outputs that render in the terminal.

## Live financial data

${financialContext}

## How the canvas renders

Each element is rendered top-to-bottom:
- \`section\`: a bold section header (e.g. "INPUTS", "RESULTS")
- \`text\`: a dim explanatory line — use for assumptions, caveats, data sources
- \`dial\`: an interactive row the user adjusts with ← → arrow keys. Shows: label [ value ] hint
- \`output\`: a computed result row. Shows: label   value   (hint)

Dial values update live — outputs re-evaluate instantly as dials change.

## Output expressions

Each output has an \`expr\` field: a single-line JavaScript arithmetic expression.
- Variables are the \`key\` fields of the dials
- Only use: + - * / Math.pow Math.log Math.abs Math.round Math.floor Math.ceil
- No variables other than dial keys, no function calls besides the Math methods above
- Expressions must be self-contained — they cannot reference other output values

Example: monthly mortgage payment with principal P, monthly rate r, n payments:
  expr: "P * r / (1 - Math.pow(1 + r, -n))"

## Design rules

1. Pre-fill dial defaults from the provided live data where relevant — show the user their real numbers
2. Add a \`text\` element when you use live data: "based on your $X monthly income"
3. Keep labels short (≤ 18 chars) — they're padded in a fixed-width column
4. Keep it focused — 3–6 dials and 1–4 outputs is ideal
5. Use \`section\` to group: "INPUTS" before dials, "RESULTS" before outputs
6. Choose \`color\` for outputs: "positive" for gains/savings, "negative" for costs/debt, "neutral" otherwise
7. Format dials and outputs consistently — if a dial is "dollar", its related output should be too
8. Set \`signed: true\` on outputs that represent deltas or values that can be negative — e.g. net savings, surplus/deficit, change in portfolio. This shows an explicit +/- prefix so the sign is always unambiguous
9. For any projection with a multi-year time horizon (retirement, investment growth, net worth, savings goals), show values in **real (inflation-adjusted) dollars** as the primary output — not nominal. Add an \`inflation\` dial (key: "inflation", default: 3, step: 0.5, min: 0, max: 8, format: "percent", hint: "annual inflation"). Convert nominal to real with: \`nominal / Math.pow(1 + inflation/100, years)\`. Label the output "Real value (today's $)" or similar. A nominal output may appear secondary.
10. If the live data includes household ages, use them to pre-fill age-related dials and personalize narrative (e.g. "years until retirement" = retirement_age - current_age). If age is not provided, add an \`age\` dial (default: 35, step: 1, min: 18, max: 80, format: "integer", hint: "your current age") so the user can set it accurately.

## Dial bindings — keep dials fresh across reopens

A dial's \`default\` is a one-time snapshot; every time the canvas is (re)opened, any dial carrying a recognized \`binding\` key gets its \`default\` refreshed from live data automatically — no code involved, this happens after you generate the spec. So whenever a dial maps to one of the keys below, set **both** \`binding\` (the key) and \`default\` (today's value, as the fallback if the binding can't resolve) — never \`binding\` without a matching \`default\`.

Binding keys: \`monthly_income_12mo_avg\`, \`monthly_expenses_12mo_avg\`, \`monthly_surplus_12mo_avg\`, \`cash_balance\`, \`taxable_brokerage\`, \`liquid_assets\`, \`retirement_balance\`, \`credit_card_debt\`, \`loan_debt\`, \`net_worth\`, \`savings_rate_pct\`, \`self_age\`, \`spouse_age\`.

Example — a dial for current cash that stays current on every reopen:
  { "type": "dial", "dial": { "key": "cash", "label": "Cash on hand", "default": 42000, "step": 1000, "min": 0, "format": "dollar", "hint": "checking + savings", "binding": "cash_balance" }}

## Toggle dials

Use \`format: "toggle"\` for a yes/no input. The value is always 0 or 1 — no \`min\`/\`max\`/\`step\`. It renders as "On"/"Off" and the user flips it with ← →.

Example:
  { "type": "dial", "dial": { "key": "has_bonus", "label": "Annual bonus?", "default": 0, "step": 1, "format": "toggle", "hint": "expecting a bonus this year" }}

## Select dials

Use \`format: "select"\` when a dial should step through a small set of named choices instead of a number. Add \`options\`: an array of display strings. The dial's value is the 0-based index into \`options\` — no \`min\`/\`max\`/\`step\` (min/max are implied by the array length).

Example:
  { "type": "dial", "dial": { "key": "filing_status", "label": "Filing status", "default": 0, "step": 1, "format": "select", "options": ["Single", "Married filing jointly", "Married filing separately", "Head of household"], "hint": "tax filing status" }}

## Conditional visibility

Any element — \`section\`, \`text\`, \`dial\`, or \`output\` — may carry a \`visible\` field: a boolean expression using the exact same grammar as \`expr\` (dial keys only, no output references). The element is shown when the expression evaluates to non-zero. Use this to gate a follow-up dial or a result behind a toggle or select choice.

Example — a bonus amount dial only shown when the bonus toggle is on:
  { "type": "dial", "dial": { "key": "has_bonus", "label": "Annual bonus?", "default": 0, "step": 1, "format": "toggle", "hint": "expecting a bonus this year" }},
  { "type": "dial", "dial": { "key": "bonus_amount", "label": "Bonus amount", "default": 5000, "step": 500, "min": 0, "format": "dollar", "hint": "expected bonus" }, "visible": "has_bonus == 1" }

## Existing screen conventions (for consistency)

The app uses these formatters:
- dollar: fmt($1234.56) → "$1,234.56", fmtCompact($1.84M) → "$1.84M"
- percent: fmtPct(7.0) → "7.0%"
- months: fmtMonths(63.4) → "63.4 mo"
- years: Math.ceil(n) + " yr"

Colors: positive=green (gains/savings), negative=red (costs/debt/loss), accent=blue (neutral emphasis)

Example canvas for "how long to pay off my credit card":
{
  "title": "Credit Card Payoff",
  "elements": [
    { "type": "text", "content": "based on your $21,494 in credit card debt" },
    { "type": "section", "label": "INPUTS" },
    { "type": "dial", "dial": { "key": "balance", "label": "Balance", "default": 21494, "step": 500, "min": 0, "format": "dollar", "hint": "current balance" }},
    { "type": "dial", "dial": { "key": "rate", "label": "APR", "default": 22, "step": 0.5, "min": 0, "max": 40, "format": "percent", "hint": "annual rate" }},
    { "type": "dial", "dial": { "key": "monthly", "label": "Monthly payment", "default": 500, "step": 50, "min": 0, "format": "dollar", "hint": "what you pay each month" }},
    { "type": "section", "label": "RESULTS" },
    { "type": "output", "output": { "label": "Months to payoff", "expr": "monthly <= balance * rate/100/12 ? Infinity : -Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)", "format": "months", "color": "neutral" }},
    { "type": "output", "output": { "label": "Total interest", "expr": "monthly * (-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)) - balance", "format": "dollar", "color": "negative" }}
  ]
}`;
}

// ─── Context loader ───────────────────────────────────────────────────────────

export type CanvasContext = {
  system: string;
  tool: typeof CANVAS_TOOL;
};

export async function loadCanvasContext(): Promise<CanvasContext> {
  const [health, pretaxRaw, profile] = await Promise.all([
    loadHealthData(),
    getSetting(PRETAX_MONTHLY_KEY),
    loadProfile(),
  ]);
  const taxableBrokerage = health.liquid - health.cash;
  const pretaxMonthly = pretaxRaw ? parseFloat(pretaxRaw) : 0;
  const savingsRate = computeSavingsRate(health.monthlyIncome, health.monthlySavings, pretaxMonthly);
  const currentYear = new Date().getFullYear();

  const householdLines: string[] = [];
  if (profile?.self.birthYear) {
    const age = currentYear - profile.self.birthYear;
    const name = profile.self.name || 'You';
    let line = `Household: ${name}, age ${age}`;
    if (profile.spouse?.birthYear) {
      const spouseAge = currentYear - profile.spouse.birthYear;
      line += `; ${profile.spouse.name || 'Spouse'}, age ${spouseAge}`;
    }
    householdLines.push(line);
    if (profile.children.length > 0) {
      const childDesc = profile.children
        .map((c) => c.birthYear > 0 ? `${c.name || 'Child'} (age ${currentYear - c.birthYear})` : (c.name || 'Child'))
        .join(', ');
      householdLines.push(`Children: ${childDesc}`);
    }
  }

  const financialContext = [
    ...householdLines,
    `Monthly income:    ${fmt(health.monthlyIncome)} (${health.basisLabel})`,
    `Monthly expenses:  ${fmt(health.avgMonthlyExpenses)} (${health.basisLabel})`,
    `Monthly surplus:   ${fmt(health.monthlySavings)} (savings rate: ${savingsRate !== null ? `${Math.round(savingsRate)}%` : 'n/a'})`,
    `Cash (checking/savings): ${fmtCompact(health.cash)}`,
    `Taxable investments (brokerage): ${fmtCompact(taxableBrokerage)}  ← no withdrawal restrictions`,
    `Total liquid (cash + brokerage): ${fmtCompact(health.liquid)}`,
    `Retirement accounts (401k/IRA/Roth): ${fmtCompact(health.retirement)}  ← restricted until ~59½`,
    `Credit card debt:  ${fmtCompact(health.totalDebt)}`,
    health.loanDebt > 0 ? `Loan debt (mortgage/auto/student): ${fmtCompact(health.loanDebt)}` : null,
    `Net worth:         ${fmtCompact(health.netWorth)}`,
  ].filter(Boolean).join('\n');
  return { system: buildSystemPrompt(financialContext), tool: CANVAS_TOOL };
}

// ─── Dial binding resolution ────────────────────────────────────────────────────
// Called at the load/generate boundary in core/tools.ts (show_canvas, load_canvas)
// — never mid-session — so an open canvas the user is actively adjusting is never
// overwritten. Resolves against the spec as stored in/going into canvas-history.json
// (binding + its original stale default), not a previously-resolved snapshot, so
// every reopen re-fetches live numbers.

// Dollar-valued bindings get rounded to the nearest whole dollar — health.ts's
// 12-month-average fields in particular come out with 10+ decimal places of
// spurious precision (e.g. 18207.755833333333), which is meaningless on a dollar
// amount and, unlike the display label, renders verbatim in the GUI's plain
// <input type="number">.
const DOLLAR_BINDING_KEYS = new Set<BindingKey>([
  'monthly_income_12mo_avg',
  'monthly_expenses_12mo_avg',
  'monthly_surplus_12mo_avg',
  'cash_balance',
  'taxable_brokerage',
  'liquid_assets',
  'retirement_balance',
  'credit_card_debt',
  'loan_debt',
  'net_worth',
]);

// Rounds a resolved binding value to the precision appropriate for its unit, before
// it is ever assigned to a dial's `default`. Scoped strictly to that assignment —
// never applied to a dial's step/min/max or to a value the user has typed in.
function roundForBinding(key: BindingKey, value: number): number {
  if (DOLLAR_BINDING_KEYS.has(key)) return Math.round(value);
  if (key === 'savings_rate_pct') return Math.round(value * 10) / 10; // matches fmtPct's 1-decimal display
  if (key === 'self_age' || key === 'spouse_age') return Math.round(value); // already whole; defensive
  return value;
}

export async function resolveCanvasBindings(spec: CanvasSpec): Promise<CanvasSpec> {
  let values: Partial<Record<BindingKey, number>> = {};
  try {
    const [health, pretaxRaw, profile] = await Promise.all([
      loadHealthData(),
      getSetting(PRETAX_MONTHLY_KEY),
      loadProfile(),
    ]);
    const taxableBrokerage = health.liquid - health.cash;
    const pretaxMonthly = pretaxRaw ? parseFloat(pretaxRaw) : 0;
    const savingsRate = computeSavingsRate(health.monthlyIncome, health.monthlySavings, pretaxMonthly);
    const currentYear = new Date().getFullYear();
    const selfAge = profile?.self.birthYear ? currentYear - profile.self.birthYear : undefined;
    const spouseAge = profile?.spouse?.birthYear ? currentYear - profile.spouse.birthYear : undefined;

    const raw: Partial<Record<BindingKey, number>> = {
      monthly_income_12mo_avg:   health.monthlyIncome,
      monthly_expenses_12mo_avg: health.avgMonthlyExpenses,
      monthly_surplus_12mo_avg:  health.monthlySavings,
      cash_balance:              health.cash,
      taxable_brokerage:         taxableBrokerage,
      liquid_assets:             health.liquid,
      retirement_balance:        health.retirement,
      credit_card_debt:          health.totalDebt,
      loan_debt:                 health.loanDebt,
      net_worth:                 health.netWorth,
      ...(savingsRate !== null ? { savings_rate_pct: savingsRate } : {}),
      ...(selfAge !== undefined ? { self_age: selfAge } : {}),
      ...(spouseAge !== undefined ? { spouse_age: spouseAge } : {}),
    };

    for (const [key, value] of Object.entries(raw) as [BindingKey, number][]) {
      values[key] = roundForBinding(key, value);
    }
  } catch {
    // Fail-soft: if live data can't be loaded at all, leave every dial's existing
    // (possibly stale) hardcoded default untouched rather than throwing.
    return spec;
  }

  return {
    ...spec,
    elements: spec.elements.map((el) => {
      if (el.type !== 'dial') return el;
      const binding = el.dial.binding as BindingKey | undefined;
      if (!binding || !Object.prototype.hasOwnProperty.call(values, binding)) return el;
      const resolved = values[binding];
      if (resolved === undefined || !isFinite(resolved)) return el;
      return { ...el, dial: { ...el.dial, default: resolved } };
    }),
  };
}

// ─── Canvas generation ────────────────────────────────────────────────────────

const CANVAS_TOOL = {
  name: 'render_canvas',
  description: 'Render an interactive financial canvas with adjustable dials and computed outputs.',
  parameters: {
    type: 'object',
    required: ['title', 'elements'],
    properties: {
      title: { type: 'string' },
      elements: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['section', 'text', 'dial', 'output'] },
            label:   { type: 'string' },
            content: { type: 'string' },
            visible: { type: 'string', description: 'Boolean expression, same grammar as output expr — dial keys only. Element shows when non-zero.' },
            dial: {
              type: 'object',
              required: ['key', 'label', 'default', 'step', 'format', 'hint'],
              properties: {
                key:     { type: 'string' },
                label:   { type: 'string' },
                default: { type: 'number' },
                step:    { type: 'number' },
                min:     { type: 'number' },
                max:     { type: 'number' },
                format:  { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years', 'toggle', 'select'] },
                hint:    { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'Required when format is "select" — display strings; the dial value is the 0-based index into this array.' },
                binding: { type: 'string', enum: [...BINDING_KEYS], description: 'Recognized live-metric key. When set, `default` is refreshed from live data on every load/reopen; always also set `default` as the fallback.' },
              },
            },
            output: {
              type: 'object',
              required: ['label', 'expr', 'format'],
              properties: {
                label:  { type: 'string' },
                expr:   { type: 'string' },
                format: { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years', 'toggle', 'select'] },
                color:  { type: 'string', enum: ['positive', 'negative', 'neutral', 'accent'] },
                signed: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};

export async function generateCanvas(
  prompt: string,
  onStatus: (msg: string) => void,
): Promise<CanvasSpec> {
  const { system, tool } = await loadCanvasContext();

  onStatus('generating…');

  let spec: CanvasSpec | null = null;

  for await (const chunk of streamResponse(system, [{ role: 'user', content: prompt }], [tool])) {
    if (chunk.type === 'tool_use' && chunk.name === 'render_canvas') {
      spec = chunk.input as unknown as CanvasSpec;
    }
  }

  if (!spec) throw new Error('Canvas generation failed — no spec returned.');
  return spec;
}
