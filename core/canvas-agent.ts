import { streamResponse } from './llm-provider.js';
import { loadHealthData } from './health.js';
import { fmt, fmtPct, fmtCompact, fmtMonths } from './fmt.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DialFormat = 'dollar' | 'percent' | 'integer' | 'months' | 'years';

export type DialDef = {
  key: string;
  label: string;
  default: number;
  step: number;
  min?: number;
  max?: number;
  format: DialFormat;
  hint: string;
};

export type OutputDef = {
  label: string;
  expr: string;         // pure JS arithmetic over dial keys — no side effects
  format: DialFormat;
  color?: 'positive' | 'negative' | 'neutral' | 'accent';
};

export type CanvasElement =
  | { type: 'section'; label: string }
  | { type: 'text';    content: string }
  | { type: 'dial';    dial: DialDef }
  | { type: 'output';  output: OutputDef };

export type CanvasSpec = {
  title: string;
  elements: CanvasElement[];
};

// ─── Expression evaluator ─────────────────────────────────────────────────────

export function evalExpr(expr: string, values: Record<string, number>): number {
  try {
    const keys = Object.keys(values);
    const vals = keys.map((k) => values[k]);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const result = new Function(...keys, `"use strict"; return (${expr});`)(...vals);
    return typeof result === 'number' && isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
}

export function fmtValue(n: number, format: DialFormat): string {
  if (!isFinite(n) || isNaN(n)) return '—';
  switch (format) {
    case 'dollar':  return fmtCompact(n);
    case 'percent': return fmtPct(n);
    case 'months':  return fmtMonths(n);
    case 'years':   return `${Math.ceil(n)} yr`;
    case 'integer': return String(Math.round(n));
  }
}

export function fmtDialValue(n: number, format: DialFormat): string {
  if (!isFinite(n) || isNaN(n)) return '—';
  switch (format) {
    case 'dollar':  return fmt(n);
    case 'percent': return fmtPct(n);
    case 'months':  return fmtMonths(n);
    case 'years':   return `${n} yr`;
    case 'integer': return String(Math.round(n));
  }
}

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
                format:  { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years'] },
                hint:    { type: 'string' },
              },
            },
            output: {
              type: 'object',
              required: ['label', 'expr', 'format'],
              properties: {
                label:  { type: 'string' },
                expr:   { type: 'string' },
                format: { type: 'string', enum: ['dollar', 'percent', 'integer', 'months', 'years'] },
                color:  { type: 'string', enum: ['positive', 'negative', 'neutral', 'accent'] },
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
  const health = await loadHealthData();
  const financialContext = [
    `Monthly income:    ${fmt(health.monthlyIncome)} (12-month avg)`,
    `Monthly expenses:  ${fmt(health.avgMonthlyExpenses)} (12-month avg)`,
    `Monthly surplus:   ${fmt(health.monthlySavings)}`,
    `Cash (checking/savings): ${fmtCompact(health.cash)}`,
    `Liquid (incl. brokerage): ${fmtCompact(health.liquid)}`,
    `Total debt (credit cards): ${fmtCompact(health.totalDebt)}`,
    `Net worth:         ${fmtCompact(health.netWorth)}`,
  ].join('\n');

  const system = buildSystemPrompt(financialContext);

  onStatus('generating…');

  let spec: CanvasSpec | null = null;

  for await (const chunk of streamResponse(system, [{ role: 'user', content: prompt }], [CANVAS_TOOL])) {
    if (chunk.type === 'tool_use' && chunk.name === 'render_canvas') {
      spec = chunk.input as unknown as CanvasSpec;
    }
  }

  if (!spec) throw new Error('Canvas generation failed — no spec returned.');
  return spec;
}
