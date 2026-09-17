// Pure canvas types + expression evaluator — no Node/db/LLM deps, safe to
// import from the GUI renderer.
import { fmt, fmtPct, fmtPctSigned, fmtCompact, fmtCompactSigned, fmtMonths } from './fmt.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DialFormat = 'dollar' | 'percent' | 'integer' | 'months' | 'years' | 'toggle' | 'select';

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
  format: DialFormat;
  color?: 'positive' | 'negative' | 'neutral' | 'accent';
  signed?: boolean;     // show explicit +/- prefix (use for deltas and values that can be negative)
};

export type CanvasElement =
  | { type: 'section'; label: string; visible?: string }
  | { type: 'text';    content: string; visible?: string }
  | { type: 'dial';    dial: DialDef; visible?: string }
  | { type: 'output';  output: OutputDef; visible?: string };

export type CanvasSpec = {
  title: string;
  elements: CanvasElement[];
};

// ─── Expression evaluator ─────────────────────────────────────────────────────
// Safe recursive-descent parser — no new Function / eval. Supports the grammar
// documented in the canvas system prompt: number/Infinity literals, dial keys,
// parentheses, unary +/-, arithmetic, comparisons, ternary, Math.{pow,log,abs,
// round,floor,ceil}. Unknown identifiers resolve to NaN; anything outside the
// grammar throws and is caught as NaN.
//
// `CanvasElement.visible` reuses this exact evaluator against the same dial-value
// scope outputs use (dial keys → numeric value; never output values, preserving the
// no-cross-output-reference rule). A renderer treats the element as visible when
// `evalExpr(visible, dialValues) !== 0`. This fails OPEN on a malformed expression:
// evalExpr returns NaN on error, and `NaN !== 0` is `true` in JS, so a broken
// `visible` expression shows the element rather than silently hiding it — consistent
// with how a broken output `expr` renders "—" instead of disappearing.

const MATH_FNS: Record<string, (...a: number[]) => number> = {
  pow: Math.pow, log: Math.log, abs: Math.abs,
  round: Math.round, floor: Math.floor, ceil: Math.ceil,
};

function lex(src: string): string[] {
  const re = /(\d+\.?\d*|\.\d+|Infinity|Math\.[a-z]+|[A-Za-z_]\w*|<=|>=|==|!=|[-+*/()<>?:,])|(\s+)/y;
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

function parseEval(toks: string[], scope: Record<string, number>): number {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => { if (next() !== t) throw new Error(`expected ${t}`); };

  function ternary(): number {
    const cond = comparison();
    if (peek() === '?') {
      next();
      const a = ternary();
      expect(':');
      const b = ternary();
      return cond !== 0 ? a : b;
    }
    return cond;
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
    return Object.prototype.hasOwnProperty.call(scope, t) ? scope[t] : NaN;
  }

  const result = ternary();
  if (p !== toks.length) throw new Error('trailing tokens');
  return result;
}

export function evalExpr(expr: string, values: Record<string, number>): number {
  if (expr.length > 500) return NaN;
  try {
    const result = parseEval(lex(expr), values);
    return typeof result === 'number' && !isNaN(result) && result !== -Infinity ? result : NaN;
  } catch {
    return NaN;
  }
}

export function fmtValue(n: number, format: DialFormat, signed = false): string {
  if (n === Infinity) return 'never';
  if (!isFinite(n) || isNaN(n)) return '—';
  switch (format) {
    case 'dollar':  return signed ? fmtCompactSigned(n) : fmtCompact(n);
    case 'percent': return signed ? fmtPctSigned(n) : fmtPct(n);
    case 'months':  return fmtMonths(n);
    case 'years':   return `${Math.ceil(n)} yr`;
    case 'integer': return String(Math.round(n));
    // toggle/select are dial-only formats by convention, but DialFormat is shared
    // with OutputDef — handle them defensively rather than rendering "undefined".
    case 'toggle':  return n !== 0 ? 'On' : 'Off';
    case 'select':  return String(Math.round(n));
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
    case 'toggle':  return n !== 0 ? 'On' : 'Off';
    case 'select': {
      const idx = Math.round(n);
      return options && idx >= 0 && idx < options.length ? options[idx] : '—';
    }
  }
}
