import { describe, it, expect } from 'vitest';
import { evalExpr, fmtValue, fmtDialValue } from '../core/canvas-spec.js';

// Pure-function table tests for the canvas expression evaluator and formatters.
// The TUI and GUI both import these from core, so this is the single place they
// are pinned; screen tests only need to cover rendering/interaction.

type Scope = Record<string, number>;
const NaNv = Number.NaN;

// [label, expr, scope, expected] — expected NaN is asserted with toBeNaN.
const EXACT: Array<[string, string, Scope, number]> = [
  // arithmetic
  ['add', 'a + b', { a: 1, b: 2 }, 3],
  ['multiply', 'a * b', { a: 3, b: 4 }, 12],
  ['subtract', 'a - b', { a: 10, b: 3 }, 7],
  ['divide', 'a / b', { a: 9, b: 3 }, 3],
  // precedence / parentheses / associativity
  ['mul binds tighter than add', '2 + 3 * 4', {}, 14],
  ['parentheses override precedence', '(2 + 3) * 4', {}, 20],
  ['subtraction is left-associative', '10 - 2 - 3', {}, 5],
  // unary
  ['unary minus', '-a', { a: 5 }, -5],
  ['double unary minus', '--a', { a: 5 }, 5],
  ['unary plus', '+a', { a: 7 }, 7],
  ['unary minus then binary add', '-a + b', { a: 3, b: 10 }, 7],
  // literals
  ['decimal literals', '1.5 + 0.5', {}, 2],
  ['integer literal', '100', {}, 100],
  ['leading-dot decimal', '.25 * 4', {}, 1],
  ['Infinity literal', 'Infinity', {}, Infinity],
  ['Infinity in ternary branch', 'a > 0 ? Infinity : 0', { a: 1 }, Infinity],
  // Math functions
  ['Math.log(1)', 'Math.log(1)', {}, 0],
  ['Math.abs negative', 'Math.abs(a)', { a: -42 }, 42],
  ['Math.abs positive', 'Math.abs(a)', { a: 42 }, 42],
  ['Math.round up', 'Math.round(1.6)', {}, 2],
  ['Math.round down', 'Math.round(1.4)', {}, 1],
  ['Math.floor', 'Math.floor(1.9)', {}, 1],
  ['Math.ceil', 'Math.ceil(1.1)', {}, 2],
  ['Math.pow two args', 'Math.pow(2, 10)', {}, 1024],
  // comparisons -> 0/1
  ['< true', 'a < b', { a: 1, b: 2 }, 1],
  ['< false', 'a < b', { a: 2, b: 1 }, 0],
  ['<= equal', 'a <= b', { a: 2, b: 2 }, 1],
  ['> true', 'a > b', { a: 5, b: 3 }, 1],
  ['>= equal', 'a >= b', { a: 3, b: 3 }, 1],
  ['< strict (equal operands)', '1 < 1', {}, 0],
  ['<= equal literals', '1 <= 1', {}, 1],
  ['> strict (equal operands)', '1 > 1', {}, 0],
  ['>= equal literals', '1 >= 1', {}, 1],
  ['== is exact, not within 1', '1 == 1.5', {}, 0],
  ['!= is exact, not within 1', '1 != 1.5', {}, 1],
  // current behaviour: plain JS float equality, no epsilon
  ['== float noise is not equal (current behaviour)', '0.1 + 0.2 == 0.3', {}, 0],
  ['!= float noise is unequal (current behaviour)', '0.1 + 0.2 != 0.3', {}, 1],
  ['== true', 'a == b', { a: 4, b: 4 }, 1],
  ['== false', 'a == b', { a: 4, b: 5 }, 0],
  ['!= true', 'a != b', { a: 4, b: 5 }, 1],
  ['!= false', 'a != b', { a: 4, b: 4 }, 0],
  // ternary
  ['ternary true', 'a > 0 ? 1 : -1', { a: 5 }, 1],
  ['ternary false', 'a > 0 ? 1 : -1', { a: -5 }, -1],
  ['ternary picks scope value (true)', 'a > 0 ? b : c', { a: 1, b: 10, c: 20 }, 10],
  ['ternary picks scope value (false)', 'a > 0 ? b : c', { a: -1, b: 10, c: 20 }, 20],
  ['nested ternary top', 'a > 2 ? 3 : a > 1 ? 2 : 1', { a: 3 }, 3],
  ['nested ternary middle', 'a > 2 ? 3 : a > 1 ? 2 : 1', { a: 2 }, 2],
  ['nested ternary bottom', 'a > 2 ? 3 : a > 1 ? 2 : 1', { a: 0 }, 1],
  // division by zero / sentinels
  ['x/0 passes Infinity through ("never" sentinel)', 'a / b', { a: 1, b: 0 }, Infinity],
  ['-x/0 (negative infinity) is NaN', '-a / b', { a: 1, b: 0 }, NaNv],
  // unknown identifiers
  ['unknown identifier', 'unknown', {}, NaNv],
  ['unknown identifier inside sum', 'a + unknown', { a: 5 }, NaNv],
  ['output key absent from scope', 'total', { has_bonus: 1 }, NaNv],
  ['prototype key is not a binding', 'constructor', {}, NaNv],
  ['0/0 is NaN', 'a / b', { a: 0, b: 0 }, NaNv],
  // malformed / out-of-grammar input
  ['over 500 chars (garbage tail, malformed anyway)', 'a +'.repeat(200), { a: 1 }, NaNv],
  // limit boundary: both are valid sums; only length differs
  ['exactly 500 chars evaluates', '1+'.repeat(249) + '1' + ' ', {}, 250],
  ['501 chars is rejected', '1+'.repeat(249) + '1' + '  ', {}, NaNv],
  ['trailing tokens', 'a + b c', { a: 1, b: 2, c: 3 }, NaNv],
  ['missing close paren', '(a + b', { a: 1, b: 2 }, NaNv],
  ['extra close paren', 'a + b)', { a: 1, b: 2 }, NaNv],
  ['empty input', '', {}, NaNv],
  ['garbage text', 'this is not >>> valid', {}, NaNv],
  ['process.env access', 'process.env.HOME', {}, NaNv],
  ['globalThis access', 'globalThis.process', {}, NaNv],
  ['arrow function syntax', '(() => 42)()', {}, NaNv],
  ['string literal', '"hello"', {}, NaNv],
  ['Math.random not allowed', 'Math.random()', {}, NaNv],
  ['Math.sqrt not allowed', 'Math.sqrt(4)', {}, NaNv],
  // logical && / || (the "visible" truth table, with and without the ternary workaround)
  ['&& both truthy', 'has_option == 1 && strategy == 1', { has_option: 1, strategy: 1 }, 1],
  ['&& first false', 'has_option == 1 && strategy == 1', { has_option: 0, strategy: 1 }, 0],
  ['&& second false', 'has_option == 1 && strategy == 1', { has_option: 1, strategy: 0 }, 0],
  ['&& both false', 'has_option == 1 && strategy == 1', { has_option: 0, strategy: 0 }, 0],
  ['ternary equivalent (1,1)', 'has_option == 1 ? (strategy == 1 ? 1 : 0) : 0', { has_option: 1, strategy: 1 }, 1],
  ['ternary equivalent (1,0)', 'has_option == 1 ? (strategy == 1 ? 1 : 0) : 0', { has_option: 1, strategy: 0 }, 0],
  ['ternary equivalent (0,1)', 'has_option == 1 ? (strategy == 1 ? 1 : 0) : 0', { has_option: 0, strategy: 1 }, 0],
  ['ternary equivalent (0,0)', 'has_option == 1 ? (strategy == 1 ? 1 : 0) : 0', { has_option: 0, strategy: 0 }, 0],
  ['visible gate evaluates to 0, not NaN', 'a == 1 && b == 1', { a: 0, b: 0 }, 0],
  ['visible gate on a dial scope', 'has_bonus == 1', { has_bonus: 1 }, 1],
  ['visible gate off', 'has_bonus == 1', { has_bonus: 0 }, 0],
  ['0 || 1 && 0 (&& tighter)', '0 || 1 && 0', {}, 0],
  ['1 || 0 && 0 (&& tighter)', '1 || 0 && 0', {}, 1],
  ['whitespace is insignificant', '  a   +\t b ', { a: 1, b: 2 }, 3],
];

describe('evalExpr (exact results)', () => {
  it.each(EXACT)('%s: %s', (_label, expr, scope, expected) => {
    const got = evalExpr(expr, scope);
    if (Number.isNaN(expected)) expect(got).toBeNaN();
    else expect(got).toBe(expected);
  });

  it('a NaN result is `!== 0`, so a malformed `visible` expression fails open', () => {
    expect(evalExpr('this is not >>> valid', {}) !== 0).toBe(true);
    expect(evalExpr('total', { has_bonus: 1 }) !== 0).toBe(true);
    expect(evalExpr('a == 1 && b == 1', { a: 0, b: 0 }) !== 0).toBe(false);
  });
});

// [label, expr, scope, expected, digits]
const CLOSE: Array<[string, string, Scope, number, number]> = [
  ['mortgage payment via Math.pow', 'P * r / (1 - Math.pow(1 + r, -n))', { P: 300_000, r: 0.005, n: 360 }, 1798.65, 0],
  ['Math.log(e) is 1', 'Math.log(a)', { a: Math.E }, 1, 10],
  ['credit-card months to payoff', '-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)', { balance: 20000, rate: 22, monthly: 500 }, 72.75, 0],
];

describe('evalExpr (floating-point results)', () => {
  it.each(CLOSE)('%s', (_label, expr, scope, expected, digits) => {
    expect(evalExpr(expr, scope)).toBeCloseTo(expected, digits);
  });

  it('retirement real-value formula grows savings when growth exceeds inflation', () => {
    const savings = 100_000;
    const r = evalExpr(
      'savings * Math.pow(1 + growth/100, years) / Math.pow(1 + inflation/100, years)',
      { savings, growth: 7, years: 20, inflation: 3 },
    );
    expect(r).toBeGreaterThan(savings);
  });
});

type OutFmt = Parameters<typeof fmtValue>[1];
const FMT_VALUE: Array<[number, OutFmt, string]> = [
  [1_840_000, 'dollar', '$1.84M'],
  [68_619, 'dollar', '$68.6K'],
  [7.5, 'percent', '7.5%'],
  [14.3, 'months', '14.3 mo'],
  [9.2, 'years', '10 yr'],
  [5, 'years', '5 yr'],
  [5, 'year', '5'],
  [2035, 'year', '2035'],
  [2035.6, 'year', '2036'],
  [Infinity, 'months', 'never'],
  [Infinity, 'dollar', 'never'],
  [NaN, 'dollar', '—'],
];

describe('fmtValue', () => {
  it.each(FMT_VALUE)('fmtValue(%s, %s) = %s', (n, format, expected) => {
    expect(fmtValue(n, format)).toBe(expected);
  });
});

// signed=true (third arg): only 'dollar' and 'percent' honour it; other formats ignore it.
// Quirks pinned as CURRENT behaviour (not endorsed):
//  - zero is '+' (n >= 0); tiny negatives that round to zero keep '-' ('-0.0%')
//  - signed dollar under $10K keeps cents ('+$5,000.00'), only >= $10K compacts
//  - months: '∞' guard is positive-only, so -5000 renders '-5000.0 mo' while 5000 is '∞'
//  - -Infinity falls through to '—' while +Infinity is 'never'
const FMT_VALUE_SIGNED: Array<[number, OutFmt, string]> = [
  [5000, 'dollar', '+$5,000.00'],
  [-5000, 'dollar', '-$5,000.00'],
  [0, 'dollar', '+$0.00'],
  [-0, 'dollar', '+$0.00'],
  [0.04, 'dollar', '+$0.04'],
  [1_840_000, 'dollar', '+$1.84M'],
  [-1_840_000, 'dollar', '-$1.84M'],
  [68_619, 'dollar', '+$68.6K'],
  [-68_619, 'dollar', '-$68.6K'],
  [7.5, 'percent', '+7.5%'],
  [-7.5, 'percent', '-7.5%'],
  [0, 'percent', '+0.0%'],
  [-0.04, 'percent', '-0.0%'],
  [14.3, 'months', '14.3 mo'],
  [-14.3, 'months', '-14.3 mo'],
  [5000, 'months', '∞'],
  [-5000, 'months', '-5000.0 mo'],
  [9.2, 'years', '10 yr'],
  [-14.3, 'years', '-14 yr'],
  [2035, 'year', '2035'],
  [-7.5, 'integer', '-7'],
  [NaN, 'dollar', '—'],
  [NaN, 'percent', '—'],
  [Infinity, 'dollar', 'never'],
  [Infinity, 'percent', 'never'],
  [-Infinity, 'dollar', '—'],
];

describe('fmtValue (signed)', () => {
  it.each(FMT_VALUE_SIGNED)('fmtValue(%s, %s, true) = %s', (n, format, expected) => {
    expect(fmtValue(n, format, true)).toBe(expected);
  });
  it('explicit signed=false matches the default', () => {
    for (const [n, format] of FMT_VALUE) expect(fmtValue(n, format, false)).toBe(fmtValue(n, format));
  });
});

type DialFmt = Parameters<typeof fmtDialValue>[1];
const SELECT = ['Single', 'Married filing jointly', 'Head of household'];
const FMT_DIAL: Array<[number, DialFmt, string[] | undefined, string]> = [
  [500, 'dollar', undefined, '$500'],
  [18208, 'dollar', undefined, '$18,208'],
  [1234.56, 'dollar', undefined, '$1,234.56'],
  [1_093_388.68, 'dollar', undefined, '$1,093,388.68'],
  [6.5, 'percent', undefined, '6.5%'],
  [0, 'toggle', undefined, 'Off'],
  [1, 'toggle', undefined, 'On'],
  [0, 'select', SELECT, 'Single'],
  [2, 'select', SELECT, 'Head of household'],
  [5, 'select', SELECT, '—'],
  [3, 'select', SELECT, '—'],
  [-1, 'select', SELECT, '—'],
  [2.4, 'select', SELECT, 'Head of household'],
  [0, 'select', undefined, '—'],
  [2035, 'year', undefined, '2035'],
  [2035.4, 'year', undefined, '2035'],
  [30, 'years', undefined, '30 yr'],
  [14.3, 'months', undefined, '14.3 mo'],
  [2.6, 'integer', undefined, '3'],
  [NaN, 'dollar', undefined, '—'],
  [Infinity, 'percent', undefined, '—'],
];

describe('fmtDialValue', () => {
  it.each(FMT_DIAL)('fmtDialValue(%s, %s, opts=%j) = %s', (n, format, options, expected) => {
    expect(fmtDialValue(n, format, options)).toBe(expected);
  });
});
