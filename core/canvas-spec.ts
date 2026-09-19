// Pure canvas types + expression evaluator — no Node/db/LLM deps, safe to
// import from the GUI renderer.
import { fmt, fmtPct, fmtPctSigned, fmtCompact, fmtCompactSigned, fmtMonths } from './fmt.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// 'year' is a plain calendar year ("2035", no suffix) — distinct from 'years', the
// plural duration format ("5 yr"). Do not conflate the two.
export type DialFormat = 'dollar' | 'percent' | 'integer' | 'months' | 'years' | 'toggle' | 'select' | 'year';

// 'toggle'/'select' only make sense for a dial (a boolean flip / an index into an
// options array) — an output or projection series is a computed value, with no
// concept of toggle-state or enum-options to render. Everything else (dollar,
// percent, integer, months, years, year) is legitimately valid for both a dial and
// a computed value.
export type OutputFormat = Exclude<DialFormat, 'toggle' | 'select'>;

export type DialDef = {
  key: string;
  label: string;
  default: number;
  step: number;
  min?: number;
  max?: number;
  format: DialFormat;
  hint: string;
  // Required by convention when format === 'select' — the dial's numeric value is the
  // 0-based index into this array. Not enforced in the type system.
  options?: string[];
  // Recognized live-metric key (see BINDING_KEYS in canvas-agent.ts). When present,
  // resolveCanvasBindings() overwrites `default` with the live value at load/generate
  // time; unrecognized/unresolvable bindings leave `default` untouched.
  binding?: string;
};

export type OutputDef = {
  label: string;
  expr: string;         // pure JS arithmetic over dial keys — no side effects
  format: OutputFormat;
  color?: 'positive' | 'negative' | 'neutral' | 'accent';
  signed?: boolean;     // show explicit +/- prefix (use for deltas and values that can be negative)
  // When present, later outputs (in array order) may reference this output's computed
  // value in their own `expr`, exactly like a dial key — see computeOutputValues() below.
  // Must be unique across the whole canvas, sharing one namespace with dial keys.
  key?: string;
};

// One row of a `list` element — a variable-length or dated collection (recurring
// expenses, income streams, one-time events). No `kind`/type tag: the intended
// pattern is one homogeneous list per category, composed with another list's total
// afterward via an output `key` reference (see computeOutputValues() above) rather
// than mixing signs/categories into a single list.
export type ListRowDef = {
  // Stable per-row id, synthesized at generation time as `${list.key}_${index}` (no
  // uuid needed). Never appears in expr — exists purely so TUI/GUI can track a row's
  // identity across add/remove without relying on array index. Assigned once, at
  // canvas generation; never recomputed from a row's current position afterward.
  id: string;
  label: string;
  amount: number;       // signed dollar amount, monthly convention (matches dial/binding units)
  startYear?: number;    // omitted = no start bound
  endYear?: number;      // omitted = open-ended (e.g. a pension with no end)
};

export type ListDef = {
  key: string;                // aggregation namespace, referenced as `key.amount` inside sum_active()/count()
  label: string;               // section-style label, e.g. "Recurring expenses"
  amountFormat?: DialFormat;   // display format for row amounts, default 'dollar'
  rows: ListRowDef[];
};

// One plotted/tabulated series of a `chart`/`table` element — evaluated once per
// step of the projection's `driver` dial (see ProjectionDef, projectSeries() below).
export type ProjectionSeriesDef = {
  label: string;
  // Same grammar as OutputDef.expr — dial keys plus sum_active()/count() over list
  // data. Deliberately NOT other outputs' `key`s: a projection varies one dial
  // across a whole range, so reading a value computed from a single fixed dial
  // snapshot (an output) raises the same cycle/ordering ambiguity that already
  // keeps `visible` dial-only — see evalExpr's doc comment above.
  expr: string;
  format: OutputFormat;
  color?: 'positive' | 'negative' | 'neutral' | 'accent';
  signed?: boolean;
};

// A `chart`/`table` element's shared shape: one or more series evaluated across
// the full range of a driver dial, one point per step. See projectSeries() below
// for how the range is walked and the 120-point cap applied.
export type ProjectionDef = {
  label: string;
  // Key of an existing `dial` element in the same spec — its min/max/step are the
  // single source of truth for the projection's range and never redeclared here.
  driver: string;
  series: ProjectionSeriesDef[];
};

export type CanvasElement =
  | { type: 'section'; label: string; visible?: string }
  | { type: 'text';    content: string; visible?: string }
  | { type: 'dial';    dial: DialDef; visible?: string }
  | { type: 'output';  output: OutputDef; visible?: string }
  | { type: 'list';    list: ListDef; visible?: string }
  | { type: 'chart';   chart: ProjectionDef; visible?: string }
  | { type: 'table';   table: ProjectionDef; visible?: string };

export type CanvasSpec = {
  title: string;
  elements: CanvasElement[];
};

// A `list` element's rows, keyed by `ListDef.key`, as sum_active()/count() expect.
// TUI/GUI build this once per render pass (see buildListScope() below) and pass it
// as evalExpr's third argument.
export type ListRowScope = { amount: number; startYear?: number; endYear?: number };

// ─── Expression evaluator ─────────────────────────────────────────────────────
// Safe recursive-descent parser — no new Function / eval. Supports the grammar
// documented in the canvas system prompt: number/Infinity literals, dial keys,
// parentheses, unary +/-, arithmetic, comparisons, logical &&/|| (standard
// precedence, left-to-right chaining, no short-circuiting — see logicalOr/
// logicalAnd below), ternary, Math.{pow,log,abs,round,floor,ceil}, and the two
// list builtins sum_active()/count() (see below). Unknown identifiers resolve to
// NaN; anything outside the grammar throws and is caught as NaN.
//
// `CanvasElement.visible` reuses this exact evaluator against the dial-value scope
// plus list data (dial keys → numeric value, and lists → sum_active()/count(); never
// output values — see computeOutputValues() below for the one place output values
// ARE readable, which is deliberately *not* `visible`). A renderer treats the
// element as visible when `evalExpr(visible, dialValues, lists) !== 0`. This fails
// OPEN on a malformed expression: evalExpr returns NaN on error, and `NaN !== 0` is
// `true` in JS, so a broken `visible` expression shows the element rather than
// silently hiding it — consistent with how a broken output `expr` renders "—"
// instead of disappearing. List data is readable from `visible` because list rows
// are static input data, structurally like dials, not derived like outputs — the
// no-output-values restriction is specifically about computation-ordering/cycle
// risk, which doesn't apply to lists.

const MATH_FNS: Record<string, (...a: number[]) => number> = {
  pow: Math.pow, log: Math.log, abs: Math.abs,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
};

function lex(src: string): string[] {
  // `.` joins the punctuation class for `list_key.amount` (sum_active's first arg).
  // Safe alongside the `\.\d+` leading-dot-decimal alternative (e.g. `.5`) because
  // that alternative is tried first in the alternation — a bare `.` only falls
  // through to the punctuation class when it isn't followed by a digit.
  const re = /(\d+\.?\d*|\.\d+|Infinity|Math\.[a-z]+|[A-Za-z_]\w*|<=|>=|==|!=|&&|\|\||[-+*/()<>?:,.])|(\s+)/y;
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`invalid token near "${src.slice(i, i + 12)}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

function parseEval(toks: string[], scope: Record<string, number>, lists: Record<string, ListRowScope[]>): number {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => { if (next() !== t) throw new Error(`expected ${t}`); };

  function ternary(): number {
    const cond = logicalOr();
    if (peek() === '?') {
      next();
      const a = ternary();
      expect(':');
      const b = ternary();
      return cond !== 0 ? a : b;
    }
    return cond;
  }
  // `||`/`&&` are additive grammar surface alongside the pre-existing comparison
  // operators — standard precedence (`||` loosest, `&&` tighter, both looser than
  // comparison), left-to-right chaining so `a && b && c` works with any number of
  // operands. No short-circuiting: this grammar is pure arithmetic with no side
  // effects, so always evaluating both operands is harmless and keeps the parser
  // simple. Truthiness matches the rest of the grammar: any nonzero number is
  // truthy (`!== 0`); results are the canonical 1/0, same as the comparison ops.
  function logicalOr(): number {
    let v = logicalAnd();
    while (peek() === '||') {
      next();
      const r = logicalAnd();
      v = (v !== 0 || r !== 0) ? 1 : 0;
    }
    return v;
  }
  function logicalAnd(): number {
    let v = comparison();
    while (peek() === '&&') {
      next();
      const r = comparison();
      v = (v !== 0 && r !== 0) ? 1 : 0;
    }
    return v;
  }
  function comparison(): number {
    const l = additive();
    const op = peek();
    if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') {
      next();
      const r = additive();
      if (op === '<')  return l < r  ? 1 : 0;
      if (op === '<=') return l <= r ? 1 : 0;
      if (op === '>')  return l > r  ? 1 : 0;
      if (op === '>=') return l >= r ? 1 : 0;
      if (op === '==') return l === r ? 1 : 0;
      if (op === '!=') return l !== r ? 1 : 0;
    }
    return l;
  }
  function additive(): number {
    let v = multiplicative();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      v = op === '+' ? v + multiplicative() : v - multiplicative();
    }
    return v;
  }
  function multiplicative(): number {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      v = op === '*' ? v * unary() : v / unary();
    }
    return v;
  }
  function unary(): number {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return primary();
  }
  function primary(): number {
    const t = next();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') { const v = ternary(); expect(')'); return v; }
    if (t === 'Infinity') return Infinity;
    if (/^\d|^\./.test(t)) return parseFloat(t);
    if (t.startsWith('Math.')) {
      const fn = MATH_FNS[t.slice(5)];
      if (!fn) throw new Error(`function not allowed: ${t}`);
      expect('(');
      const args: number[] = [];
      if (peek() !== ')') {
        args.push(ternary());
        while (peek() === ',') { next(); args.push(ternary()); }
      }
      expect(')');
      return fn(...args);
    }
    // sum_active(list_key.amount, year_expr) — sums row.amount over lists[list_key]
    // for every row whose [startYear, endYear] range (open-ended on either side)
    // contains yearVal, inclusive on both ends. Fixed-shape grammar, not a generic
    // function call: the `.amount` field name is the only one supported (anything
    // else after the dot is a parse error → NaN, same as any other malformed expr).
    // This is the one builtin that resolves a named journey (mortgage payoff /
    // college costs) via the year filter — an unconditional sum was explicitly
    // rejected as insufficient. An unrecognized list_key returns NaN (consistent
    // with the unknown-identifier convention above), not 0 — that's reserved for a
    // recognized-but-empty list.
    if (t === 'sum_active' && peek() === '(') {
      next();
      const listKey = next();
      if (listKey === undefined) throw new Error('sum_active: expected list key');
      expect('.');
      const field = next();
      if (field !== 'amount') throw new Error('sum_active: expected .amount');
      expect(',');
      const yearVal = ternary();
      expect(')');
      const rows = lists[listKey];
      if (!rows) return NaN;
      let sum = 0;
      for (const row of rows) {
        const lo = row.startYear ?? -Infinity;
        const hi = row.endYear ?? Infinity;
        if (yearVal >= lo && yearVal <= hi) sum += row.amount;
      }
      return sum;
    }
    // count(list_key) — unconditional row count. Unrecognized list_key → NaN; a
    // recognized-but-empty list → 0 (same distinction as sum_active above).
    if (t === 'count' && peek() === '(') {
      next();
      const listKey = next();
      if (listKey === undefined) throw new Error('count: expected list key');
      expect(')');
      const rows = lists[listKey];
      return rows ? rows.length : NaN;
    }
    return Object.prototype.hasOwnProperty.call(scope, t) ? scope[t] : NaN;
  }

  const result = ternary();
  if (p !== toks.length) throw new Error('trailing tokens');
  return result;
}

export function evalExpr(
  expr: string,
  values: Record<string, number>,
  lists: Record<string, ListRowScope[]> = {},
): number {
  if (expr.length > 500) return NaN;
  try {
    const result = parseEval(lex(expr), values, lists);
    return typeof result === 'number' && !isNaN(result) && result !== -Infinity ? result : NaN;
  } catch {
    return NaN;
  }
}

// Extracts the { listKey: rows[] } shape sum_active()/count() expect from a
// canvas's full element array. Optional convenience for TUI/GUI so both don't
// duplicate the same reduce — call once per render pass and pass the result as
// evalExpr's/computeOutputValues' `lists` argument.
export function buildListScope(elements: CanvasElement[]): Record<string, ListRowScope[]> {
  const scope: Record<string, ListRowScope[]> = {};
  for (const el of elements) {
    if (el.type === 'list') scope[el.list.key] = el.list.rows;
  }
  return scope;
}

// Computes every output element's value, in original array order, so a later output
// may reference an earlier output's `key` in its own `expr` — the same way it already
// references a dial key. Deliberately takes the *full, unfiltered* `elements` array
// and ignores `visible` entirely: hiding is render-only (matching how a hidden dial
// already freezes its value instead of resetting), so a hidden output still computes
// and is still available for a later output to reference. Callers filter what to
// *render*; this function is only responsible for what to *compute*.
//
// IMPORTANT — shared namespace: dial keys and output keys are looked up in one flat
// scope object when evaluating an output's `expr` (`{ ...dialValues, ...outputValuesSoFar }`).
// This means every dial key and every output key across the whole canvas must be
// distinct — a duplicate silently shadows whichever value was merged in first.
//
// A forward reference — an output's `expr` naming a *later* output's key, its own
// key, or a typo — is not special-cased: at evaluation time that key simply isn't in
// `outputValuesSoFar` yet (or ever), so evalExpr's existing unknown-identifier-→-NaN
// behavior applies and the result is NaN. Because references can only ever point
// backward, cycles are structurally impossible — no cycle detection is needed.
export function computeOutputValues(
  elements: CanvasElement[],
  dialValues: Record<string, number>,
  lists: Record<string, ListRowScope[]> = {},
): number[] {
  const outputValuesSoFar: Record<string, number> = {};
  const results: number[] = [];
  for (const el of elements) {
    if (el.type !== 'output') continue;
    const scope = { ...dialValues, ...outputValuesSoFar };
    const value = evalExpr(el.output.expr, scope, lists);
    if (el.output.key) outputValuesSoFar[el.output.key] = value;
    results.push(value);
  }
  return results;
}

// One evaluated step of a projection: `x` is the driver dial's value at that step,
// `values` is each series' evalExpr result, in series array order.
export type ProjectionPoint = { x: number; values: number[] };

// Hard cap on returned points — a runtime safety backstop, not the expected case
// (the canvas-agent system prompt targets far fewer steps for normal driver
// ranges). When the driver's raw step count would exceed this, the range is
// resampled to exactly this many evenly-spaced points spanning the full
// [min, max] — never truncated from `min`, which would silently cut off the tail
// of the horizon.
const PROJECTION_POINT_CAP = 120;

// Walks `driverKey`'s dial from min to max by step (min/max/step looked up from
// the matching `dial` element in `elements` — never redeclared on the projection
// itself), evaluating every series' `expr` at each step via evalExpr directly
// (deliberately NOT computeOutputValues — see ProjectionSeriesDef's doc comment).
// A missing driver dial, missing min/max, a non-positive step, or max < min is a
// structural "nothing to show" and returns `[]` — distinct from evalExpr's
// per-value NaN-on-arithmetic-error convention, so renderers should treat an
// empty result as unavailable rather than rendering a NaN-filled row.
export function projectSeries(
  elements: CanvasElement[],
  dialValues: Record<string, number>,
  lists: Record<string, ListRowScope[]>,
  driverKey: string,
  series: ProjectionSeriesDef[],
): ProjectionPoint[] {
  const driverEl = elements.find(
    (el): el is Extract<CanvasElement, { type: 'dial' }> => el.type === 'dial' && el.dial.key === driverKey,
  );
  if (!driverEl) return [];
  const { min, max, step } = driverEl.dial;
  if (min === undefined || max === undefined || step === undefined) return [];
  if (step <= 0 || max < min) return [];

  // Small epsilon guards against float error in (max - min) / step landing just
  // under a whole number (e.g. 0.30000000000000004) and undercounting by one.
  const rawCount = Math.floor((max - min) / step + 1e-9) + 1;

  const xs: number[] = [];
  if (rawCount <= PROJECTION_POINT_CAP) {
    for (let i = 0; i < rawCount; i++) xs.push(min + i * step);
  } else {
    const n = PROJECTION_POINT_CAP;
    for (let i = 0; i < n; i++) xs.push(min + (i * (max - min)) / (n - 1));
  }

  return xs.map((x) => {
    const scope = { ...dialValues, [driverKey]: x };
    return { x, values: series.map((s) => evalExpr(s.expr, scope, lists)) };
  });
}

export function fmtValue(n: number, format: OutputFormat, signed = false): string {
  if (n === Infinity) return 'never';
  if (!isFinite(n) || isNaN(n)) return '—';
  switch (format) {
    case 'dollar':  return signed ? fmtCompactSigned(n) : fmtCompact(n);
    case 'percent': return signed ? fmtPctSigned(n) : fmtPct(n);
    case 'months':  return fmtMonths(n);
    case 'years':   return `${Math.ceil(n)} yr`;
    case 'integer': return String(Math.round(n));
    case 'year':    return String(Math.round(n));
  }
}

// `options` is only meaningful (and only needed) when format === 'select' — it's the
// dial's options array, used to render the label for the current 0-based index.
export function fmtDialValue(n: number, format: DialFormat, options?: string[]): string {
  if (!isFinite(n) || isNaN(n)) return '—';
  switch (format) {
    case 'dollar':  return Number.isInteger(n) ? fmt(n, 0) : fmt(n);
    case 'percent': return fmtPct(n);
    case 'months':  return fmtMonths(n);
    case 'years':   return `${n} yr`;
    case 'integer': return String(Math.round(n));
    case 'year':    return String(Math.round(n));
    case 'toggle':  return n !== 0 ? 'On' : 'Off';
    case 'select': {
      const idx = Math.round(n);
      return options && idx >= 0 && idx < options.length ? options[idx] : '—';
    }
  }
}
