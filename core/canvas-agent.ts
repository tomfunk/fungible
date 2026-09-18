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
- Variables are the \`key\` fields of the dials, plus (see below) the \`key\` fields of earlier outputs
- Only use: + - * / Math.pow Math.log Math.abs Math.round Math.floor Math.ceil, plus (when the canvas has \`list\` elements) \`sum_active(list_key.amount, year_expr)\` and \`count(list_key)\` — see "Lists" below
- No function calls besides the above

Example: monthly mortgage payment with principal P, monthly rate r, n payments:
  expr: "P * r / (1 - Math.pow(1 + r, -n))"

## Referencing an earlier output from a later one

Give an output a \`key\` (same rules as a dial key) and any *later* output's \`expr\` can
reference it, exactly like a dial key. This only works forward — an output cannot
reference a later output's key, or its own key (that resolves to NaN, not an error).
There is no need to give an output a \`key\` unless a later output actually references it.

**Global uniqueness**: dial keys and output keys share one namespace. Every key across
the whole canvas — every dial's \`key\` and every output's \`key\` — must be distinct, or
one value silently shadows another.

Example — an annual figure derived from a monthly one:
  { "type": "output", "output": { "key": "monthly_surplus", "label": "Monthly surplus", "expr": "income - expenses", "format": "dollar", "signed": true }},
  { "type": "output", "output": { "label": "Annual surplus", "expr": "monthly_surplus * 12", "format": "dollar", "signed": true }}

Note: a \`visible\` expression still only sees dial keys, never output keys — output
values are not available there.

## Lists — variable-length or dated collections

Use a \`list\` element instead of individual dials when the scenario involves a
variable-length or dated collection: recurring expenses, income streams, one-time
events, years of college, a mortgage. Seed 2–4 realistic starting rows, pulling
from the live data where you can.

  { "type": "list", "list": {
      "key": "expenses",
      "label": "Recurring expenses",
      "amountFormat": "dollar",
      "rows": [
        { "label": "Mortgage", "amount": 2800, "startYear": 2020, "endYear": 2040 },
        { "label": "Daycare", "amount": 1900, "startYear": 2023, "endYear": 2031 },
        { "label": "Car payment", "amount": 450, "startYear": 2024, "endYear": 2028 }
      ]
  }}

Each row is \`{ label, amount, startYear?, endYear? }\` — never include an \`id\`, it's
assigned automatically. Omit \`startYear\`/\`endYear\` for a row with no start bound or
no end (e.g. a pension that never stops).

Pair a list with a \`year\`-format dial the user can scrub, and use
\`sum_active(list_key.amount, year_expr)\` in an output's \`expr\` to compute "total
active as of year X" — the sum of every row whose [startYear, endYear] range
(inclusive) contains that year:

  { "type": "dial", "dial": { "key": "year", "label": "Year", "default": 2026, "step": 1, "min": 2020, "max": 2045, "format": "year", "hint": "scrub to see costs at a given year" }},
  { "type": "output", "output": { "label": "Active expenses", "expr": "sum_active(expenses.amount, year)", "format": "dollar", "color": "negative" }}

\`count(list_key)\` returns the number of rows in a list, unconditionally (no year
filter) — e.g. \`count(expenses)\`.

Keep one list per homogeneous category — don't mix income and expenses, or
differently-signed amounts, in a single list's rows. To combine two lists (e.g. net
cash flow = income minus expenses), give each list's total its own output \`key\` and
reference both from a later output (see "Referencing an earlier output from a later
one" above), rather than mixing categories inside one list.

### Worked example — mortgage payoff and college costs, scrubbed by one year dial

{
  "title": "Mortgage & College Costs Over Time",
  "elements": [
    { "type": "section", "label": "INPUTS" },
    { "type": "dial", "dial": { "key": "year", "label": "Year", "default": 2026, "step": 1, "min": 2020, "max": 2045, "format": "year", "hint": "scrub to any year" }},
    { "type": "list", "list": { "key": "expenses", "label": "Recurring expenses", "amountFormat": "dollar", "rows": [
      { "label": "Mortgage", "amount": 2800, "startYear": 2020, "endYear": 2040 },
      { "label": "Property tax", "amount": 500, "startYear": 2020 }
    ]}},
    { "type": "list", "list": { "key": "college", "label": "College", "amountFormat": "dollar", "rows": [
      { "label": "Older child (age 12)", "amount": 2200, "startYear": 2036, "endYear": 2040 },
      { "label": "Younger child (age 9)", "amount": 2200, "startYear": 2038, "endYear": 2042 }
    ]}},
    { "type": "section", "label": "RESULTS" },
    { "type": "output", "output": { "key": "monthly_expenses", "label": "Monthly expenses", "expr": "sum_active(expenses.amount, year)", "format": "dollar", "color": "negative" }},
    { "type": "output", "output": { "key": "monthly_college", "label": "Monthly college costs", "expr": "sum_active(college.amount, year)", "format": "dollar", "color": "negative" }},
    { "type": "output", "output": { "label": "Total monthly outlay", "expr": "monthly_expenses + monthly_college", "format": "dollar", "color": "negative", "signed": true }}
  ]
}

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

Any element — \`section\`, \`text\`, \`dial\`, \`output\`, or \`list\` — may carry a \`visible\` field: a boolean expression using the exact same grammar as \`expr\` (dial keys and list data via \`sum_active\`/\`count\` — never output references). The element is shown when the expression evaluates to non-zero. Use this to gate a follow-up dial or a result behind a toggle or select choice.

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
            type: { type: 'string', enum: ['section', 'text', 'dial', 'output', 'list'] },
            label:   { type: 'string' },
            content: { type: 'string' },
            visible: { type: 'string', description: 'Boolean expression, same grammar as output expr — dial keys and list data (sum_active/count) only, never output values. Element shows when non-zero.' },
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
                format:  { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years', 'toggle', 'select', 'year'] },
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
                format: { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years', 'toggle', 'select', 'year'] },
                color:  { type: 'string', enum: ['positive', 'negative', 'neutral', 'accent'] },
                signed: { type: 'boolean' },
                key:    { type: 'string', description: 'Optional. When set, later outputs (in element order) may reference this value in their own expr, the same way they reference a dial key. Must be unique across the whole canvas (shared namespace with dial keys).' },
              },
            },
            list: {
              type: 'object',
              required: ['key', 'label', 'rows'],
              description: 'A variable-length or dated collection (recurring expenses, income streams, one-time events). Use with sum_active(list_key.amount, year_expr) / count(list_key) in an output expr — see the "Lists" section above.',
              properties: {
                key:          { type: 'string', description: 'Aggregation namespace — referenced as `key.amount` inside sum_active()/count(). Shares the global key namespace with dials and outputs.' },
                label:        { type: 'string', description: 'Section-style label, e.g. "Recurring expenses".' },
                amountFormat: { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years', 'toggle', 'select', 'year'], description: 'Display format for row amounts. Defaults to "dollar".' },
                rows: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['label', 'amount'],
                    properties: {
                      label:     { type: 'string' },
                      amount:    { type: 'number', description: 'Signed dollar amount, monthly convention.' },
                      startYear: { type: 'number', description: 'Omit for no start bound.' },
                      endYear:   { type: 'number', description: 'Omit for open-ended (e.g. a pension with no end).' },
                    },
                  },
                  description: 'Never include an `id` on a row — it is assigned automatically.',
                },
              },
            },
          },
        },
      },
    },
  },
};

// The tool schema deliberately doesn't ask the LLM for a row `id` (see the `list`
// schema's rows description above) — ids are mechanical and easy to get wrong or
// collide, so they're synthesized here, once, right after generation. This is a
// one-time assignment: it must never be re-run against an already-generated spec
// (e.g. when persisting a later row edit), since `${list.key}_${index}` would then
// reassign ids to their *current* array position — defeating the whole point of a
// stable id that survives add/remove (see ListRowDef.id's doc comment).
function synthesizeListRowIds(spec: CanvasSpec): CanvasSpec {
  return {
    ...spec,
    elements: spec.elements.map((el) => {
      if (el.type !== 'list') return el;
      return {
        ...el,
        list: {
          ...el.list,
          rows: el.list.rows.map((row, i) => ({ ...row, id: `${el.list.key}_${i}` })),
        },
      };
    }),
  };
}

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
  return synthesizeListRowIds(spec);
}
