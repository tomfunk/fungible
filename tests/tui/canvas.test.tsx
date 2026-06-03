import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { evalExpr, fmtValue, fmtDialValue, type CanvasSpec } from '../../core/canvas-agent.js';
import { CanvasView } from '../../tui/Canvas.js';

// ─── generateCanvas (mocked LLM) ──────────────────────────────────────────────

const MOCK_HEALTH = {
  avgMonthlyExpenses: 12000, monthlyIncome: 15000, monthlySavings: 3000,
  cash: 60000, liquid: 800000, totalDebt: 20000, netWorth: 1_800_000,
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

vi.mock('../../core/health.js', () => ({ loadHealthData: async () => MOCK_HEALTH }));
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
  it('evaluates simple arithmetic', () => {
    expect(evalExpr('a + b', { a: 1, b: 2 })).toBe(3);
    expect(evalExpr('a * b', { a: 3, b: 4 })).toBe(12);
  });

  it('evaluates mortgage payment formula', () => {
    // $300k, 6% annual (0.5% monthly), 360 payments
    const P = 300_000, r = 0.005, n = 360;
    const result = evalExpr('P * r / (1 - Math.pow(1 + r, -n))', { P, r, n });
    expect(result).toBeCloseTo(1798.65, 0);
  });

  it('returns NaN for bad expressions', () => {
    expect(isNaN(evalExpr('not valid js!!!', {}))).toBe(true);
  });

  it('returns NaN when result is non-finite', () => {
    // division by zero
    expect(isNaN(evalExpr('a / b', { a: 1, b: 0 }))).toBe(true);
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
