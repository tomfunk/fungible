import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import { evalExpr, fmtValue, fmtDialValue, type CanvasSpec } from '../../core/canvas-agent.js';
import { CanvasView } from '../../tui/Canvas.js';

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw lastErr;
}

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
  it('formats dollar, dropping cents for whole values', () => {
    expect(fmtDialValue(500, 'dollar')).toBe('$500');
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
    expect(frame).toContain('$500,000');
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

// ─── CanvasView — toggle dial ─────────────────────────────────────────────────

const TOGGLE_SPEC: CanvasSpec = {
  title: 'Toggle Test',
  elements: [
    { type: 'dial', dial: { key: 'autopay', label: 'Autopay', default: 0, step: 1, min: 0, max: 1, format: 'toggle', hint: 'pay automatically' } },
  ],
};

describe('CanvasView — toggle dial', () => {
  it('renders Off/On via fmtDialValue', () => {
    const { lastFrame } = render(<CanvasView spec={TOGGLE_SPEC} />);
    expect(lastFrame()).toContain('Off');
  });

  it('flips On with the right arrow and Off again with the right arrow', async () => {
    const r = render(<CanvasView spec={TOGGLE_SPEC} />);
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('On'));
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('Off'));
  });

  it('flips with the left arrow too — either direction toggles', async () => {
    const r = render(<CanvasView spec={TOGGLE_SPEC} />);
    r.stdin.write('\x1B[D');
    await waitFor(() => expect(r.lastFrame()).toContain('On'));
    r.stdin.write('\x1B[D');
    await waitFor(() => expect(r.lastFrame()).toContain('Off'));
  });

  it('resets to default with [r]', async () => {
    const r = render(<CanvasView spec={TOGGLE_SPEC} />);
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('On'));
    r.stdin.write('r');
    await waitFor(() => expect(r.lastFrame()).toContain('Off'));
  });

  it('does not enter numeric edit mode on Enter', async () => {
    const r = render(<CanvasView spec={TOGGLE_SPEC} />);
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 30));
    expect(r.lastFrame()).not.toContain('Enter confirm');
    expect(r.lastFrame()).toContain('Off');
  });
});

// ─── CanvasView — select dial ─────────────────────────────────────────────────

const SELECT_SPEC: CanvasSpec = {
  title: 'Select Test',
  elements: [
    {
      type: 'dial',
      dial: {
        key: 'filing', label: 'Filing status', default: 0, step: 1, format: 'select',
        options: ['Single', 'Married filing jointly', 'Head of household'],
        hint: 'tax filing status',
      },
    },
  ],
};

describe('CanvasView — select dial', () => {
  it('renders options[value] via fmtDialValue', () => {
    const { lastFrame } = render(<CanvasView spec={SELECT_SPEC} />);
    expect(lastFrame()).toContain('Single');
  });

  it('cycles forward through options with the right arrow, wrapping at the end', async () => {
    const r = render(<CanvasView spec={SELECT_SPEC} />);
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('Married filing jointly'));
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('Head of household'));
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('Single'));
  });

  it('cycles backward with the left arrow, wrapping at the start', async () => {
    const r = render(<CanvasView spec={SELECT_SPEC} />);
    r.stdin.write('\x1B[D');
    await waitFor(() => expect(r.lastFrame()).toContain('Head of household'));
  });

  it('resets to the default index with [r]', async () => {
    const r = render(<CanvasView spec={SELECT_SPEC} />);
    r.stdin.write('\x1B[C');
    await waitFor(() => expect(r.lastFrame()).toContain('Married filing jointly'));
    r.stdin.write('r');
    await waitFor(() => expect(r.lastFrame()).toContain('Single'));
  });

  it('does not enter numeric edit mode on Enter', async () => {
    const r = render(<CanvasView spec={SELECT_SPEC} />);
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 30));
    expect(r.lastFrame()).not.toContain('Enter confirm');
  });
});

// ─── CanvasView — `visible` filtering ─────────────────────────────────────────

const VISIBILITY_SPEC: CanvasSpec = {
  title: 'Visibility Test',
  elements: [
    { type: 'section', label: 'INPUTS' },
    { type: 'dial', dial: { key: 'showExtra', label: 'Show extra', default: 1, step: 1, min: 0, max: 1, format: 'toggle', hint: 'toggle extra section' } },
    { type: 'dial', dial: { key: 'sub', label: 'Sub dial', default: 5, step: 1, min: 0, max: 10, format: 'integer', hint: 'sub value' }, visible: 'showExtra == 1' },
    { type: 'text', content: 'extra info here', visible: 'showExtra == 1' },
    { type: 'dial', dial: { key: 'other', label: 'Other', default: 3, step: 1, min: 0, format: 'integer', hint: 'always visible' } },
    { type: 'section', label: 'RESULTS' },
    { type: 'output', output: { label: 'Doubled', expr: 'sub * 2', format: 'integer' } },
  ],
};

describe('CanvasView — visible filtering', () => {
  it('shows a gated element when its `visible` expression is truthy', () => {
    const { lastFrame } = render(<CanvasView spec={VISIBILITY_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sub dial');
    expect(frame).toContain('extra info here');
  });

  it('hides a gated element once its `visible` expression evaluates falsy, and it is skipped from dial nav', async () => {
    const r = render(<CanvasView spec={VISIBILITY_SPEC} />);
    // cursor starts on "Show extra" — flip it off, hiding the sub dial and text.
    r.stdin.write('\x1B[C');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('Sub dial');
      expect(frame).not.toContain('extra info here');
      expect(frame).toContain('Other');
    });

    // nav should now skip straight from "Show extra" to "Other".
    r.stdin.write('\x1B[B'); // down
    // "Other" row should be selected (integer step hint only shown on the selected row)
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
  });

  it('freezes a hidden dial\'s value instead of resetting it — it survives hide → show', async () => {
    const r = render(<CanvasView spec={VISIBILITY_SPEC} />);
    // move to the sub dial and change its value
    r.stdin.write('\x1B[B'); // down to "Sub dial"
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
    r.stdin.write('\x1B[C'); // 5 -> 6
    r.stdin.write('\x1B[C'); // 6 -> 7
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Doubled');
      expect(frame).toContain('14'); // 7 * 2
    });

    // move back up to the toggle and hide the sub dial
    r.stdin.write('\x1B[A'); // up to "Show extra"
    await waitFor(() => expect(r.lastFrame()).toContain('← → toggle'));
    r.stdin.write('\x1B[C'); // flip off — sub dial now hidden
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('Sub dial');
      // output still reflects the frozen value of 7, not a reset to default (5)
      expect(frame).toContain('14');
    });

    // show it again — value should still be 7, not reset to the default of 5
    r.stdin.write('\x1B[C'); // flip back on
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Sub dial');
      expect(frame).toContain('14');
    });
  });

  it('does not crash and lands the cursor somewhere sane when the selected dial hides itself', async () => {
    const SELF_HIDE_SPEC: CanvasSpec = {
      title: 'Self hide',
      elements: [
        { type: 'dial', dial: { key: 'enabled', label: 'Enabled', default: 1, step: 1, min: 0, max: 1, format: 'toggle', hint: 'enable this option' }, visible: 'enabled != 0' },
        { type: 'dial', dial: { key: 'fallback', label: 'Fallback', default: 3, step: 1, min: 0, format: 'integer', hint: 'always visible' } },
      ],
    };
    const r = render(<CanvasView spec={SELF_HIDE_SPEC} />);
    // cursor starts on "Enabled" (first visible dial); flip it off — it hides itself.
    expect(() => r.stdin.write('\x1B[C')).not.toThrow();
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('Enabled');
      // cursor should have fallen back to the remaining visible dial without crashing.
      expect(frame).toContain('Fallback');
      expect(frame).toContain('← → ±1');
    });

    // further navigation and interaction on the fallback dial should work normally.
    expect(() => r.stdin.write('\x1B[C')).not.toThrow();
    await waitFor(() => expect(r.lastFrame()).toContain('4')); // 3 -> 4
  });
});

// ─── CanvasView — row height stays constant regardless of hint length ────────
// Regression test for issue #145 follow-up: a long unselected hint used to wrap
// to a second line while the selected row's short control hint didn't, so moving
// the cursor changed that row's height and reflowed every row below it.

const LONG_HINT_SPEC: CanvasSpec = {
  title: 'Long Hint Test',
  elements: [
    { type: 'dial', dial: { key: 'a', label: 'First dial', default: 1, step: 1, min: 0, max: 1, format: 'toggle', hint: 'bound to your 12-month income average, only appears when the toggle above is on and stays that way' } },
    { type: 'dial', dial: { key: 'b', label: 'Second dial', default: 3, step: 1, min: 0, format: 'integer', hint: 'short hint' } },
  ],
};

describe('CanvasView — constant row height regardless of hint length', () => {
  it('renders the same total line count whether the long-hint dial is selected or not', async () => {
    const r = render(<CanvasView spec={LONG_HINT_SPEC} />);
    // Initial state: the long-hint dial is selected, so it shows its short control
    // hint ("← → toggle") — nothing to truncate yet.
    const lineCountSelected = (r.lastFrame() ?? '').split('\n').length;

    r.stdin.write('\x1B[B'); // move selection down to the short-hint dial — the
    // long-hint dial is now unselected and must render its full (long) hint,
    // truncated to fit on one line rather than wrapping.
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
    const lineCountUnselected = (r.lastFrame() ?? '').split('\n').length;

    expect(lineCountUnselected).toBe(lineCountSelected);
  });

  it('truncates the long hint instead of wrapping it onto a second line', async () => {
    const r = render(<CanvasView spec={LONG_HINT_SPEC} />);
    r.stdin.write('\x1B[B'); // deselect the long-hint dial so it renders its hint text
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
    const frame = r.lastFrame() ?? '';
    // The full hint text must not appear verbatim (it would if wrapped in full);
    // a truncated prefix should still be visible, on the same line as the label.
    expect(frame).not.toContain('only appears when the toggle above is on and stays that way');
    expect(frame).toContain('First dial');
    expect(frame).toContain('bound to your');
  });
});

// ─── CanvasView — long dial label doesn't wrap or break column alignment ─────
// Regression test for a real user report: a dial label longer than LABEL_W (18)
// used to render at full length via `label.padEnd(labelWidth)`, which only pads
// short strings and does nothing to long ones — Ink then wrapped the oversized
// label inside the row's constrained-width Box, dragging the value bracket and
// everything after it onto a second/third line and destroying the row's column
// alignment. The label column must now truncate with an ellipsis instead.

const LONG_LABEL = 'This is a way too long dial label';

const LONG_LABEL_SPEC: CanvasSpec = {
  title: 'Long Label Test',
  elements: [
    { type: 'dial', dial: { key: 'normal', label: 'Normal dial', default: 5, step: 1, min: 0, max: 10, format: 'integer', hint: 'a normal-length label' } },
    { type: 'dial', dial: { key: 'long', label: LONG_LABEL, default: 5, step: 1, min: 0, max: 10, format: 'integer', hint: 'a way-too-long label' } },
  ],
};

describe('CanvasView — long dial label stays on one line', () => {
  it('does not grow the frame\'s line count when a label exceeds the label column width', () => {
    const { lastFrame } = render(<CanvasView spec={LONG_LABEL_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n');
    // title + 2 dial rows, no wrapped continuation lines from the oversized label
    expect(lines.length).toBe(3);
  });

  it('truncates the long label with an ellipsis instead of wrapping it', () => {
    const { lastFrame } = render(<CanvasView spec={LONG_LABEL_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(LONG_LABEL);
    expect(frame).toContain('…');
  });

  it('keeps the value bracket aligned in the same column as a normal-length-label row', () => {
    const { lastFrame } = render(<CanvasView spec={LONG_LABEL_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.includes('['));
    expect(lines.length).toBe(2);
    const bracketCols = lines.map((l) => l.indexOf('['));
    expect(bracketCols[0]).toBe(bracketCols[1]);
  });
});

// ─── CanvasView — long label + large dollar value doesn't break the value bracket ──
// Second half of the same user report: "numbers end with '.', values outside/below
// the box". The `[ value ]` construction used to be three independent sibling
// Text nodes (open bracket, padded value, close bracket, plus a fourth cursor node
// while editing) with no bounded width of their own — same defect the label column
// had, just one column over. Under width pressure (a long label on another row
// forcing the layout narrower, or simply a formatted value wider than the nominal
// column, e.g. "$1,093,388.68") each node could wrap independently, dropping the
// closing "]" — or trailing digits — onto their own line. DialRow now wraps the
// whole bracket+value(+cursor) construction in one fixed-width TruncatedText so
// Yoga measures and truncates it as a single unit instead.
//
// ink-testing-library hardcodes its virtual terminal to 100 columns, which is wide
// enough that this row never actually gets squeezed — so a plain `render()` call
// exercises the "value wider than the nominal column" half of the fix but not the
// "genuinely narrow terminal" half. `renderAtWidth` below reimplements
// ink-testing-library's own render() (see node_modules/ink-testing-library) with a
// configurable `columns`, so the squeeze case gets covered too.

function renderAtWidth(width: number, tree: React.ReactElement) {
  class Stdout extends EventEmitter {
    columns = width;
    frames: string[] = [];
    _lastFrame?: string;
    write = (frame: string) => { this.frames.push(frame); this._lastFrame = frame; };
    lastFrame = () => this._lastFrame;
  }
  class Stderr extends EventEmitter {
    frames: string[] = [];
    _lastFrame?: string;
    write = (frame: string) => { this.frames.push(frame); this._lastFrame = frame; };
    lastFrame = () => this._lastFrame;
  }
  class Stdin extends EventEmitter {
    isTTY = true;
    write = () => {};
    setEncoding = () => {};
    setRawMode = () => {};
    resume = () => {};
    pause = () => {};
    ref = () => {};
    unref = () => {};
    read = () => null;
  }
  const stdout = new Stdout();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new Stderr() as unknown as NodeJS.WriteStream,
    stdin: new Stdin() as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { lastFrame: stdout.lastFrame, unmount: instance.unmount };
}

const LONG_LABEL_AND_VALUE_SPEC: CanvasSpec = {
  title: 'Long Label And Value Test',
  elements: [
    { type: 'dial', dial: { key: 'normal', label: 'Normal dial', default: 5, step: 1, min: 0, max: 10, format: 'integer', hint: 'a normal-length label' } },
    { type: 'dial', dial: { key: 'long', label: LONG_LABEL, default: 1_093_388.68, step: 1, min: 0, format: 'dollar', hint: 'a way-too-long label' } },
  ],
};

describe('CanvasView — long label + large dollar value keeps the value bracket on one line', () => {
  it('does not grow the frame\'s line count at the default (100-column) width', () => {
    const { lastFrame } = render(<CanvasView spec={LONG_LABEL_AND_VALUE_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBe(3);
  });

  it('keeps the closing bracket on the same line as the opening bracket at the default width', () => {
    const { lastFrame } = render(<CanvasView spec={LONG_LABEL_AND_VALUE_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n');
    const valueLine = lines.find((l) => l.includes('$1,093,388.68'));
    expect(valueLine).toBeDefined();
    expect(valueLine).toContain('[');
    expect(valueLine).toContain(']');
    expect(valueLine!.indexOf('[')).toBeLessThan(valueLine!.indexOf(']'));
  });

  it.each([80, 70, 60, 50, 40])(
    'keeps every row to one line and the bracket intact at a squeezed %i-column width',
    (width) => {
      const { lastFrame, unmount } = renderAtWidth(width, <CanvasView spec={LONG_LABEL_AND_VALUE_SPEC} />);
      const lines = (lastFrame() ?? '').split('\n').filter((l) => l.trim().length > 0);
      // Title + one row per dial — never more, however narrow the terminal:
      // a value/label that can't fit gets truncated, not wrapped onto a new line.
      expect(lines.length).toBe(3);
      const bracketLines = lines.filter((l) => l.includes('['));
      expect(bracketLines.length).toBe(2);
      for (const line of bracketLines) {
        // The closing bracket must be present and on the same line as the
        // opening one — never dropped, and never pushed to its own line.
        expect(line).toContain('[');
        expect(line).toContain(']');
        expect(line.indexOf('[')).toBeLessThan(line.indexOf(']'));
      }
      unmount();
    },
  );
});

// ─── CanvasView — value column stays aligned across rows of very different widths ──
// Third act of the same user report: fixing the per-row overflow (above) by sizing
// each row's box to `Math.max(valueWidth, displayValue.length)` traded one bug for
// another — a row with an unusually long formatted value (e.g. a 7-figure balance)
// got a wider box *only for that row*, so its closing bracket landed in a different
// column than every other row's. The fix is to compute the value-column width once
// per canvas (the widest formatted value across every visible dial+output) and share
// it across all rows, instead of letting each row size itself independently.

const MIXED_WIDTH_VALUE_SPEC: CanvasSpec = {
  title: 'Mixed Width Value Test',
  elements: [
    { type: 'dial', dial: { key: 'small', label: 'Small dial', default: 100, step: 10, min: 0, format: 'dollar', hint: 'a small dollar value' } },
    { type: 'dial', dial: { key: 'large', label: 'Large dial', default: 1_093_389, step: 1000, min: 0, format: 'dollar', hint: 'a much larger dollar value' } },
  ],
};

describe('CanvasView — value column width is shared across rows, not per-row', () => {
  it('opens and closes the value bracket at the same column for every row', () => {
    const { lastFrame } = render(<CanvasView spec={MIXED_WIDTH_VALUE_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.includes('['));
    expect(lines.length).toBe(2);
    const openCols = lines.map((l) => l.indexOf('['));
    const closeCols = lines.map((l) => l.indexOf(']'));
    // Both rows' boxes must line up in the same columns — not just each row's own
    // bracket pair being internally consistent (that was already true after the
    // previous fix; this is the cross-row alignment that fix broke).
    expect(openCols[0]).toBe(openCols[1]);
    expect(closeCols[0]).toBe(closeCols[1]);
  });
});
