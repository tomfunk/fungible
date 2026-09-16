import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { evalExpr, fmtValue, fmtDialValue, type CanvasSpec } from '../../core/canvas-agent.js';
import { CanvasView } from '../../tui/Canvas.js';

// ─── generateCanvas (mocked LLM) ──────────────────────────────────────────────

const MOCK_HEALTH = {
  avgMonthlyExpenses: 12000, monthlyIncome: 15000, monthlySavings: 3000,
  cash: 60000, liquid: 800000, retirement: 900000, totalDebt: 20000, loanDebt: 0, netWorth: 1_800_000,
};

const MOCK_SPEC: CanvasSpec = {
  title: 'Credit Card Payoff',
  elements: [
    { type: 'section', label: 'INPUTS' },
    { type: 'dial', dial: { key: 'balance', label: 'Balance', default: 20000, step: 500, min: 0, format: 'dollar', hint: 'current balance' } },
    { type: 'dial', dial: { key: 'rate',    label: 'APR',     default: 22,    step: 0.5, min: 0, max: 40, format: 'percent', hint: 'annual rate' } },
    { type: 'dial', dial: { key: 'monthly', label: 'Monthly payment', default: 500, step: 50, min: 0, format: 'dollar', hint: 'what you pay' } },
    { type: 'section', label: 'RESULTS' },
    { type: 'output', output: { label: 'Months to payoff', expr: '-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)', format: 'months', color: 'neutral' } },
    { type: 'output', output: { label: 'Total interest', expr: 'monthly * (-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)) - balance', format: 'dollar', color: 'negative' } },
  ],
};

vi.mock('../../core/health.js', () => ({ loadHealthData: async () => MOCK_HEALTH, computeSavingsRate: () => 20 }));
vi.mock('../../core/profile.js', () => ({ loadProfile: async () => null, householdMembers: () => [] }));
vi.mock('../../core/settings.js', () => ({ getSetting: async () => null, PRETAX_MONTHLY_KEY: 'pretax_monthly' }));
vi.mock('../../core/llm-provider.js', () => ({
  streamResponse: vi.fn(async function* () {
    yield { type: 'tool_use', id: 'test-id', name: 'render_canvas', input: MOCK_SPEC };
    yield { type: 'done' };
  }),
}));

describe('generateCanvas', () => {
  it('returns the spec from the tool call', async () => {
    const { generateCanvas } = await import('../../core/canvas-agent.js');
    const statuses: string[] = [];
    const spec = await generateCanvas('how long to pay off my credit card', (s) => { statuses.push(s); });
    expect(spec.title).toBe('Credit Card Payoff');
    expect(spec.elements.filter((e) => e.type === 'dial')).toHaveLength(3);
    expect(spec.elements.filter((e) => e.type === 'output')).toHaveLength(2);
    expect(statuses).toContain('generating…');
  });

  it('throws if no tool call is returned', async () => {
    vi.mocked(
      (await import('../../core/llm-provider.js')).streamResponse
    ).mockImplementationOnce(async function* () {
      yield { type: 'text', delta: 'sorry, I cannot help' };
      yield { type: 'done' };
    });
    const { generateCanvas } = await import('../../core/canvas-agent.js');
    await expect(generateCanvas('bad prompt', () => {})).rejects.toThrow('no spec returned');
  });
});

// ─── evalExpr ─────────────────────────────────────────────────────────────────

describe('evalExpr', () => {
  // Basic arithmetic
  it('evaluates simple arithmetic', () => {
    expect(evalExpr('a + b', { a: 1, b: 2 })).toBe(3);
    expect(evalExpr('a * b', { a: 3, b: 4 })).toBe(12);
    expect(evalExpr('a - b', { a: 10, b: 3 })).toBe(7);
    expect(evalExpr('a / b', { a: 9, b: 3 })).toBe(3);
  });

  it('respects operator precedence', () => {
    expect(evalExpr('2 + 3 * 4', {})).toBe(14);
    expect(evalExpr('(2 + 3) * 4', {})).toBe(20);
    expect(evalExpr('10 - 2 - 3', {})).toBe(5);
  });

  it('handles unary minus and plus', () => {
    expect(evalExpr('-a', { a: 5 })).toBe(-5);
    expect(evalExpr('--a', { a: 5 })).toBe(5);
    expect(evalExpr('+a', { a: 7 })).toBe(7);
    expect(evalExpr('-a + b', { a: 3, b: 10 })).toBe(7);
  });

  it('handles number literals including decimals', () => {
    expect(evalExpr('1.5 + 0.5', {})).toBe(2);
    expect(evalExpr('100', {})).toBe(100);
    expect(evalExpr('.25 * 4', {})).toBe(1);
  });

  it('handles the Infinity literal', () => {
    expect(evalExpr('Infinity', {})).toBe(Infinity);
    expect(evalExpr('a > 0 ? Infinity : 0', { a: 1 })).toBe(Infinity);
  });

  // Math functions
  it('evaluates mortgage payment formula with Math.pow', () => {
    const P = 300_000, r = 0.005, n = 360;
    const result = evalExpr('P * r / (1 - Math.pow(1 + r, -n))', { P, r, n });
    expect(result).toBeCloseTo(1798.65, 0);
  });

  it('evaluates Math.log', () => {
    expect(evalExpr('Math.log(1)', {})).toBe(0);
    expect(evalExpr('Math.log(a)', { a: Math.E })).toBeCloseTo(1, 10);
  });

  it('evaluates Math.abs', () => {
    expect(evalExpr('Math.abs(a)', { a: -42 })).toBe(42);
    expect(evalExpr('Math.abs(a)', { a: 42 })).toBe(42);
  });

  it('evaluates Math.round / Math.floor / Math.ceil', () => {
    expect(evalExpr('Math.round(1.6)', {})).toBe(2);
    expect(evalExpr('Math.round(1.4)', {})).toBe(1);
    expect(evalExpr('Math.floor(1.9)', {})).toBe(1);
    expect(evalExpr('Math.ceil(1.1)', {})).toBe(2);
  });

  it('evaluates Math.pow with two arguments', () => {
    expect(evalExpr('Math.pow(2, 10)', {})).toBe(1024);
  });

  // Comparisons
  it('evaluates comparison operators returning 0 or 1', () => {
    expect(evalExpr('a < b', { a: 1, b: 2 })).toBe(1);
    expect(evalExpr('a < b', { a: 2, b: 1 })).toBe(0);
    expect(evalExpr('a <= b', { a: 2, b: 2 })).toBe(1);
    expect(evalExpr('a > b', { a: 5, b: 3 })).toBe(1);
    expect(evalExpr('a >= b', { a: 3, b: 3 })).toBe(1);
    expect(evalExpr('a == b', { a: 4, b: 4 })).toBe(1);
    expect(evalExpr('a == b', { a: 4, b: 5 })).toBe(0);
    expect(evalExpr('a != b', { a: 4, b: 5 })).toBe(1);
    expect(evalExpr('a != b', { a: 4, b: 4 })).toBe(0);
  });

  // Ternary
  it('evaluates ternary operator', () => {
    expect(evalExpr('a > 0 ? 1 : -1', { a: 5 })).toBe(1);
    expect(evalExpr('a > 0 ? 1 : -1', { a: -5 })).toBe(-1);
    expect(evalExpr('a > 0 ? b : c', { a: 1, b: 10, c: 20 })).toBe(10);
    expect(evalExpr('a > 0 ? b : c', { a: -1, b: 10, c: 20 })).toBe(20);
  });

  it('evaluates nested ternary', () => {
    expect(evalExpr('a > 2 ? 3 : a > 1 ? 2 : 1', { a: 3 })).toBe(3);
    expect(evalExpr('a > 2 ? 3 : a > 1 ? 2 : 1', { a: 2 })).toBe(2);
    expect(evalExpr('a > 2 ? 3 : a > 1 ? 2 : 1', { a: 0 })).toBe(1);
  });

  // Real canvas formulas
  it('evaluates credit-card payoff formula', () => {
    const balance = 20000, rate = 22, monthly = 500;
    const result = evalExpr(
      '-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)',
      { balance, rate, monthly },
    );
    expect(result).toBeCloseTo(72.75, 0);
  });

  it('evaluates retirement real-value formula', () => {
    const savings = 100_000, growth = 7, years = 20, inflation = 3;
    const result = evalExpr(
      'savings * Math.pow(1 + growth/100, years) / Math.pow(1 + inflation/100, years)',
      { savings, growth, years, inflation },
    );
    expect(result).toBeGreaterThan(savings);
  });

  // Sentinel values
  it('passes Infinity through (used for "never" payoff sentinel)', () => {
    expect(evalExpr('a / b', { a: 1, b: 0 })).toBe(Infinity);
  });

  it('returns NaN for negative-infinity', () => {
    expect(isNaN(evalExpr('-a / b', { a: 1, b: 0 }))).toBe(true);
  });

  // Unknown identifiers
  it('returns NaN for unknown identifiers', () => {
    expect(isNaN(evalExpr('unknown', {}))).toBe(true);
    expect(isNaN(evalExpr('a + unknown', { a: 5 }))).toBe(true);
  });

  // Error cases
  it('returns NaN for expressions exceeding 500 chars', () => {
    expect(isNaN(evalExpr('a +'.repeat(200), { a: 1 }))).toBe(true);
  });

  it('returns NaN for trailing tokens', () => {
    expect(isNaN(evalExpr('a + b c', { a: 1, b: 2, c: 3 }))).toBe(true);
  });

  it('returns NaN for unmatched parentheses', () => {
    expect(isNaN(evalExpr('(a + b', { a: 1, b: 2 }))).toBe(true);
    expect(isNaN(evalExpr('a + b)', { a: 1, b: 2 }))).toBe(true);
  });

  it('returns NaN for empty input', () => {
    expect(isNaN(evalExpr('', {}))).toBe(true);
  });

  // Security: tokens outside the grammar must not execute
  it('returns NaN for process.env access attempts', () => {
    expect(isNaN(evalExpr('process.env.HOME', {}))).toBe(true);
  });

  it('returns NaN for globalThis access attempts', () => {
    expect(isNaN(evalExpr('globalThis.process', {}))).toBe(true);
  });

  it('returns NaN for arrow function syntax', () => {
    expect(isNaN(evalExpr('(() => 42)()', {}))).toBe(true);
  });

  it('returns NaN for string literals (outside grammar)', () => {
    expect(isNaN(evalExpr('"hello"', {}))).toBe(true);
  });

  it('returns NaN for disallowed Math methods', () => {
    expect(isNaN(evalExpr('Math.random()', {}))).toBe(true);
    expect(isNaN(evalExpr('Math.sqrt(4)', {}))).toBe(true);
  });
});

// ─── fmtValue / fmtDialValue ──────────────────────────────────────────────────

describe('fmtValue', () => {
  it('formats dollar with compact', () => {
    expect(fmtValue(1_840_000, 'dollar')).toBe('$1.84M');
    expect(fmtValue(68_619, 'dollar')).toBe('$68.6K');
  });

  it('formats percent', () => {
    expect(fmtValue(7.5, 'percent')).toBe('7.5%');
  });

  it('formats months', () => {
    expect(fmtValue(14.3, 'months')).toBe('14.3 mo');
  });

  it('formats years with ceil', () => {
    expect(fmtValue(9.2, 'years')).toBe('10 yr');
  });

  it('returns never for Infinity', () => {
    expect(fmtValue(Infinity, 'months')).toBe('never');
    expect(fmtValue(Infinity, 'dollar')).toBe('never');
  });

  it('returns — for NaN', () => {
    expect(fmtValue(NaN, 'dollar')).toBe('—');
  });
});

describe('fmtDialValue', () => {
  it('formats dollar with full precision', () => {
    expect(fmtDialValue(500, 'dollar')).toBe('$500.00');
    expect(fmtDialValue(1234.56, 'dollar')).toBe('$1,234.56');
  });

  it('formats percent', () => {
    expect(fmtDialValue(6.5, 'percent')).toBe('6.5%');
  });
});

// ─── CanvasView rendering ─────────────────────────────────────────────────────

const MORTGAGE_SPEC: CanvasSpec = {
  title: 'Mortgage Payment',
  elements: [
    { type: 'section', label: 'INPUTS' },
    { type: 'text', content: 'adjust dials to explore scenarios' },
    { type: 'dial', dial: { key: 'price', label: 'Home price', default: 500_000, step: 10_000, min: 0, format: 'dollar', hint: 'purchase price' } },
    { type: 'dial', dial: { key: 'down', label: 'Down payment', default: 20, step: 5, min: 0, max: 100, format: 'percent', hint: 'of purchase price' } },
    { type: 'dial', dial: { key: 'rate', label: 'Interest rate', default: 6.5, step: 0.25, min: 0, max: 20, format: 'percent', hint: 'annual rate' } },
    { type: 'dial', dial: { key: 'term', label: 'Term', default: 30, step: 5, min: 5, max: 30, format: 'years', hint: 'loan length' } },
    { type: 'section', label: 'RESULTS' },
    {
      type: 'output', output: {
        label: 'Monthly payment',
        expr: '(price * (1 - down/100)) * (rate/100/12) / (1 - Math.pow(1 + rate/100/12, -(term*12)))',
        format: 'dollar',
        color: 'negative',
      },
    },
  ],
};

describe('CanvasView', () => {
  it('renders title and section headers', () => {
    const { lastFrame } = render(<CanvasView spec={MORTGAGE_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Mortgage Payment');
    expect(frame).toContain('INPUTS');
    expect(frame).toContain('RESULTS');
  });

  it('renders text element', () => {
    const { lastFrame } = render(<CanvasView spec={MORTGAGE_SPEC} />);
    expect(lastFrame()).toContain('adjust dials to explore scenarios');
  });

  it('renders dial labels and default values', () => {
    const { lastFrame } = render(<CanvasView spec={MORTGAGE_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Home price');
    expect(frame).toContain('$500,000.00');
    expect(frame).toContain('Down payment');
    expect(frame).toContain('Interest rate');
  });

  it('computes and renders the mortgage output', () => {
    const { lastFrame } = render(<CanvasView spec={MORTGAGE_SPEC} />);
    // $500k, 20% down = $400k loan, 6.5% annual, 30yr → ~$2,528/mo
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Monthly payment');
    expect(frame).toContain('$2,528');
  });
});
