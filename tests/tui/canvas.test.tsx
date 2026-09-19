import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import { evalExpr, fmtValue, fmtDialValue, type CanvasSpec } from '../../core/canvas-agent.js';
import type { CanvasHistoryEntry } from '../../core/canvas-history.js';
import { Canvas, CanvasView, type LoadedCanvasSpec } from '../../tui/Canvas.js';

// core/canvas-history.ts does real readFileSync/writeFileSync against
// ~/.fungible paths — mocked here so list-row persistence tests (further below)
// never touch real disk. updateHistoryEntrySpec/resolveAndWriteCanvasSpec are
// spies so tests can assert they were called with the expected args; loadHistory/
// deleteHistoryEntry are unused by CanvasView but stubbed too in case a future
// test in this file exercises the outer `Canvas` history browser.
vi.mock('../../core/canvas-history.js', () => ({
  loadHistory: vi.fn(() => []),
  deleteHistoryEntry: vi.fn(() => true),
  updateHistoryEntrySpec: vi.fn((id: string, spec: CanvasSpec) => ({
    id, title: spec.title, prompt: '', spec, createdAt: '', updatedAt: new Date().toISOString(),
  } satisfies CanvasHistoryEntry)),
  resolveAndWriteCanvasSpec: vi.fn(async (spec: CanvasSpec) => spec),
}));

// A bare stdin.write() only enqueues a Node 'data' event — it does not itself wait
// for the resulting React re-render to commit. Chaining several writes back to
// back with no await between them lets Ink's useInput handlers all run against the
// SAME stale render (React 18 batches the setState calls), so e.g. a down-arrow
// immediately followed by Enter can still see the pre-arrow selection. Every
// multi-step key sequence below awaits `tick()` (or an assertion via `waitFor`)
// between steps so each keypress is handled against the just-committed render.
async function tick(ms = 20): Promise<void> {
  await new Promise((res) => setTimeout(res, ms));
}

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

// ─── CanvasView — chained `visible` conditions (canvas issue #145, Effort A) ──
// Flagged during Effort A planning as untested territory: a toggle gating a
// select, and that select's chosen option in turn gating a further dial
// (toggle → select → dial, three levels). `visible` has no chaining-specific
// code path — every element's `visible` is evaluated independently against the
// current dialValues on every render (see visibleElements above) — so this is
// a proof test, not new behavior.
const CHAINED_VISIBILITY_SPEC: CanvasSpec = {
  title: 'Chained Visibility Test',
  elements: [
    { type: 'section', label: 'INPUTS' },
    { type: 'dial', dial: { key: 'has_option', label: 'Has option', default: 0, step: 1, min: 0, max: 1, format: 'toggle', hint: 'enable extra options' } },
    { type: 'dial', dial: { key: 'strategy', label: 'Strategy', default: 0, step: 1, format: 'select', options: ['Conservative', 'Aggressive'], hint: 'pick a strategy' }, visible: 'has_option == 1' },
    // step=2 (vs. "Other" below's step=1) so their selected-row control hints
    // ("← → ±2" vs. "← → ±1") are distinguishable in frame assertions.
    { type: 'dial', dial: { key: 'strategy_detail', label: 'Detail', default: 9, step: 2, min: 0, format: 'integer', hint: 'fine-tune the aggressive strategy' }, visible: 'has_option == 1 && strategy == 1' },
    { type: 'dial', dial: { key: 'other', label: 'Other', default: 3, step: 1, min: 0, format: 'integer', hint: 'always visible' } },
    { type: 'section', label: 'RESULTS' },
    // hidden dials still compute (unconditional dialValues), so this output can
    // reference strategy_detail even while its row is hidden — used below to
    // prove the frozen value survives a hide → show round trip.
    { type: 'output', output: { label: 'Doubled value', expr: 'strategy_detail * 2', format: 'integer' } },
  ],
};

describe('CanvasView — chained `visible` conditions', () => {
  it('toggle off: neither the select nor the further dial render or are reachable', async () => {
    const r = render(<CanvasView spec={CHAINED_VISIBILITY_SPEC} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('Strategy');
    expect(frame).not.toContain('Detail');
    expect(frame).toContain('Has option');
    expect(frame).toContain('Other');

    // cursor starts on "Has option"; down arrow should skip straight to "Other",
    // proving neither hidden dial is a cursor stop.
    r.stdin.write('\x1B[B');
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
  });

  it('toggle on, select on its first option: select renders, further dial stays hidden', async () => {
    const r = render(<CanvasView spec={CHAINED_VISIBILITY_SPEC} />);
    r.stdin.write('\x1B[C'); // flip "Has option" on
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Strategy');
      expect(frame).toContain('Conservative'); // default option (index 0)
      expect(frame).not.toContain('Detail');
    });

    // down arrow from the toggle should land on "Strategy" itself...
    r.stdin.write('\x1B[B');
    await waitFor(() => expect(r.lastFrame()).toContain('← → cycle'));
    // ...and a further down arrow should skip straight to "Other", since the
    // detail dial is still gated on strategy == 1.
    r.stdin.write('\x1B[B');
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±1'));
  });

  it('toggle on, select cycled to its second option: further dial appears and becomes reachable', async () => {
    const r = render(<CanvasView spec={CHAINED_VISIBILITY_SPEC} />);
    r.stdin.write('\x1B[C'); // flip "Has option" on
    await waitFor(() => expect(r.lastFrame()).toContain('Conservative'));

    r.stdin.write('\x1B[B'); // down to "Strategy"
    await waitFor(() => expect(r.lastFrame()).toContain('← → cycle'));
    r.stdin.write('\x1B[C'); // cycle Conservative (0) -> Aggressive (1)
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Aggressive');
      expect(frame).toContain('Detail');
    });

    // now reachable: down arrow from "Strategy" lands on "Detail" (← → ±2),
    // not straight through to "Other" (← → ±1).
    r.stdin.write('\x1B[B');
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±2'));
  });

  it('toggling back off immediately hides both, and the detail dial\'s value is frozen — not reset — through the round trip', async () => {
    const r = render(<CanvasView spec={CHAINED_VISIBILITY_SPEC} />);
    r.stdin.write('\x1B[C'); // flip "Has option" on
    await waitFor(() => expect(r.lastFrame()).toContain('Conservative'));
    r.stdin.write('\x1B[B'); // down to "Strategy"
    await waitFor(() => expect(r.lastFrame()).toContain('← → cycle'));
    r.stdin.write('\x1B[C'); // cycle to Aggressive (1) — reveals "Detail"
    await waitFor(() => expect(r.lastFrame()).toContain('Detail'));

    // move onto "Detail" and change its value away from the default (9 -> 11)
    r.stdin.write('\x1B[B');
    await waitFor(() => expect(r.lastFrame()).toContain('← → ±2'));
    r.stdin.write('\x1B[C');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('11');
      expect(frame).toContain('22'); // Doubled value output: 11 * 2
    });

    // walk back up to the toggle (Detail -> Strategy -> Has option) and flip it off
    r.stdin.write('\x1B[A');
    await waitFor(() => expect(r.lastFrame()).toContain('← → cycle'));
    r.stdin.write('\x1B[A');
    await waitFor(() => expect(r.lastFrame()).toContain('← → toggle'));
    r.stdin.write('\x1B[C'); // flip off
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('Strategy');
      expect(frame).not.toContain('Detail');
      // frozen, not reset: the output still reflects 11 (22), not the default of 9 (18)
      expect(frame).toContain('22');
    });

    // flip back on — select is still on Aggressive (1), so "Detail" reappears
    // with its previously-set value intact rather than reset to its default.
    r.stdin.write('\x1B[C');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Aggressive');
      expect(frame).toContain('Detail');
      expect(frame).toContain('11');
      expect(frame).toContain('22');
    });
  });
});

// ─── CanvasView — inter-output references (canvas issue #145, Effort B) ──────
// A later output's `expr` may reference an earlier output's `key`, resolved via
// computeOutputValues() — the same way it already references a dial key.

const OUTPUT_REF_SPEC: CanvasSpec = {
  title: 'Output Reference Test',
  elements: [
    { type: 'dial', dial: { key: 'income', label: 'Income', default: 5_000, step: 100, min: 0, format: 'dollar', hint: 'monthly income' } },
    { type: 'output', output: { label: 'Monthly', key: 'm', expr: 'income * 0.1', format: 'dollar' } },
    { type: 'output', output: { label: 'Annual', expr: 'm * 12', format: 'dollar' } },
  ],
};

describe('CanvasView — inter-output references', () => {
  it('resolves a later output referencing an earlier output by key', () => {
    const { lastFrame } = render(<CanvasView spec={OUTPUT_REF_SPEC} />);
    const frame = lastFrame() ?? '';
    // income * 0.1 = 500; 500 * 12 = 6,000
    expect(frame).toContain('Monthly');
    expect(frame).toContain('$500');
    expect(frame).toContain('Annual');
    expect(frame).toContain('$6,000');
  });

  it('recomputes a dependent output when the underlying dial changes', async () => {
    const r = render(<CanvasView spec={OUTPUT_REF_SPEC} />);
    r.stdin.write('\x1B[C'); // income 5,000 -> 5,100
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      // 5,100 * 0.1 = 510; 510 * 12 = 6,120
      expect(frame).toContain('$510');
      expect(frame).toContain('$6,120');
    });
  });

  it('renders — (NaN) rather than crashing when an output references a nonexistent/later key', () => {
    const BAD_REF_SPEC: CanvasSpec = {
      title: 'Bad Reference Test',
      elements: [
        { type: 'dial', dial: { key: 'income', label: 'Income', default: 5_000, step: 100, min: 0, format: 'dollar', hint: 'monthly income' } },
        // references "later", which is only defined below — a forward reference
        // never resolves (evalExpr sees an unknown identifier and returns NaN).
        { type: 'output', output: { label: 'Broken', expr: 'later * 2', format: 'dollar' } },
        { type: 'output', output: { label: 'Later', key: 'later', expr: 'income * 0.2', format: 'dollar' } },
      ],
    };
    expect(() => render(<CanvasView spec={BAD_REF_SPEC} />)).not.toThrow();
    const { lastFrame } = render(<CanvasView spec={BAD_REF_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Broken');
    expect(frame).toContain('—');
    expect(frame).toContain('Later');
    expect(frame).toContain('$1,000'); // income * 0.2 = 1,000, unaffected by the broken row above it
  });

  it('a hidden output still computes and is referenceable by a later visible output', () => {
    const HIDDEN_OUTPUT_SPEC: CanvasSpec = {
      title: 'Hidden Output Reference Test',
      elements: [
        { type: 'dial', dial: { key: 'income', label: 'Income', default: 5_000, step: 100, min: 0, format: 'dollar', hint: 'monthly income' } },
        { type: 'dial', dial: { key: 'some_toggle', label: 'Some toggle', default: 0, step: 1, min: 0, max: 1, format: 'toggle', hint: 'toggle it' } },
        // hidden — visible only when some_toggle is on — but still computes.
        { type: 'output', output: { label: 'Hidden base', key: 'base', expr: 'income * 0.1', format: 'dollar' }, visible: 'some_toggle == 1' },
        { type: 'output', output: { label: 'Visible derived', expr: 'base * 3', format: 'dollar' } },
      ],
    };
    const { lastFrame } = render(<CanvasView spec={HIDDEN_OUTPUT_SPEC} />);
    const frame = lastFrame() ?? '';
    // "Hidden base" is not rendered (some_toggle defaults to off)...
    expect(frame).not.toContain('Hidden base');
    // ...but it still computed, so the visible output referencing it by key is correct:
    // income * 0.1 = 500; 500 * 3 = 1,500 — not NaN/"—" despite the row being hidden.
    expect(frame).toContain('Visible derived');
    expect(frame).toContain('$1,500');
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

// ─── CanvasView — list element (canvas issue #145, Effort A) ─────────────────
// List rows flatten into the existing top-level ↑↓ cursor list: each row is 4
// stops (label, amount, start, end), navigated exactly like dials. [a] appends
// a row, [d] removes the one under the cursor. start/end are independent
// bounded ±1 year steppers (canvas issue #145 follow-up) — never free-typed
// as a combined "2020-2040" string, though each still accepts an exact typed
// value via the same numeric edit-buffer + clamp-on-commit flow every other
// dial/list cell already uses.

const LIST_SPEC: CanvasSpec = {
  title: 'List Test',
  elements: [
    {
      type: 'list',
      list: {
        key: 'expenses',
        label: 'Recurring expenses',
        rows: [
          { id: 'r1', label: 'Rent', amount: -2000 },
          { id: 'r2', label: 'Car payment', amount: -400, startYear: 2020, endYear: 2026 },
          { id: 'r3', label: 'Streaming', amount: -50 },
        ],
      },
    },
    { type: 'output', output: { label: 'Total (2024)', expr: 'sum_active(expenses.amount, 2024)', format: 'dollar' } },
  ],
};

describe('CanvasView — list rows render with aligned columns', () => {
  it('shows every row label and its formatted amount', () => {
    const { lastFrame } = render(<CanvasView spec={LIST_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Recurring expenses');
    expect(frame).toContain('Rent');
    expect(frame).toContain('Car payment');
    expect(frame).toContain('Streaming');
    expect(frame).toContain('-$2,000');
    expect(frame).toContain('-$400');
    expect(frame).toContain('-$50');
    // r1/r3 have no start/end bound -> "any"/"ongoing"; r2 is bounded 2020-2026,
    // rendered as two independent cells rather than one combined string.
    expect(frame).toContain('any');
    expect(frame).toContain('2020');
    expect(frame).toContain('2026');
    expect(frame).toContain('ongoing');
  });

  it('aligns every row\'s amount/start/end brackets in the same columns', () => {
    const { lastFrame } = render(<CanvasView spec={LIST_SPEC} />);
    const lines = (lastFrame() ?? '').split('\n').filter((l) => l.includes('['));
    expect(lines.length).toBe(3); // one line per list row
    const bracketCols = lines.map((l) => {
      const cols: number[] = [];
      let idx = l.indexOf('[');
      while (idx !== -1) { cols.push(idx); idx = l.indexOf('[', idx + 1); }
      return cols;
    });
    // amount, start, end -> 3 bracketed cells per row.
    expect(bracketCols.every((cols) => cols.length === 3)).toBe(true);
    for (let col = 0; col < 3; col++) {
      expect(new Set(bracketCols.map((cols) => cols[col])).size).toBe(1);
    }
  });

  it('computes the sum_active output over the list rows for the given year', () => {
    const { lastFrame } = render(<CanvasView spec={LIST_SPEC} />);
    const frame = lastFrame() ?? '';
    // 2024 is within [2020,2026] for the car payment, so all 3 rows are active:
    // -2000 + -400 + -50 = -2450.
    expect(frame).toContain('Total (2024)');
    expect(frame).toContain('-$2,450');
  });
});

describe('CanvasView — list row add/remove', () => {
  it('adds a row via [a], and the cursor lands on it so [d] removes the just-added row', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    // Cursor starts on the first stop overall — this spec has no dial, so that's
    // r1's label cell.
    r.stdin.write('a');
    await waitFor(() => expect(r.lastFrame()).toContain('New row'));
    expect((r.lastFrame() ?? '').split('\n').filter((l) => l.includes('['))).toHaveLength(4);

    // Selection followed the new row (addRow sets selectedKey to its label cell) —
    // [d] here removes the row we just added, not one of the original three.
    expect(() => r.stdin.write('d')).not.toThrow();
    await waitFor(() => expect(r.lastFrame()).not.toContain('New row'));
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Rent');
    expect(frame).toContain('Car payment');
    expect(frame).toContain('Streaming');
  });

  it('does not crash when the last row in a list is removed, and falls back to the empty-list placeholder', async () => {
    const ONE_ROW_SPEC: CanvasSpec = {
      title: 'One row',
      elements: [
        { type: 'list', list: { key: 'solo', label: 'Solo list', rows: [{ id: 'only', label: 'Only row', amount: 10 }] } },
      ],
    };
    const r = render(<CanvasView spec={ONE_ROW_SPEC} />);
    expect(() => r.stdin.write('d')).not.toThrow();
    await waitFor(() => expect(r.lastFrame()).toContain('No rows yet'));

    // Cursor safety: further keys (nav, add) must not crash once the list is empty.
    expect(() => r.stdin.write('\x1B[B')).not.toThrow();
    expect(() => r.stdin.write('a')).not.toThrow();
    await waitFor(() => expect(r.lastFrame()).toContain('New row'));
  });

  it('recomputes a sum_active output as rows are added and removed', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    await waitFor(() => expect(r.lastFrame()).toContain('-$2,450'));

    // Move from r1:label down 4 stops (label, amount, start, end) to land on
    // r2:label, then remove the car payment row (-400) — total should become
    // -2,050.
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('d');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('Car payment');
      expect(frame).toContain('-$2,050');
    });
  });
});

describe('CanvasView — list cell editing', () => {
  it('edits a cell in place: Enter seeds the buffer, typing changes it, Enter commits', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    r.stdin.write('\x1B[B'); await tick(); // r1:label -> r1:amount
    r.stdin.write('\r');     await tick(); // Enter — edit mode, buffer seeded "-2000"
    expect(r.lastFrame()).toContain('-2000'); // bracket now shows the raw edit buffer
    // Clear "-2000" (5 chars) and retype "-3000" — one stdin.write() per character,
    // matching how a real terminal delivers keystrokes one at a time (a single
    // multi-char write here is delivered as one bulk `input` string, which fails
    // the numeric cell's single-character regex gate and is silently dropped).
    for (let i = 0; i < 5; i++) r.stdin.write('\x7F');
    for (const ch of '-3000') r.stdin.write(ch);
    await tick();
    r.stdin.write('\r'); // commit
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('-$3,000');
      // dependent output recomputed: -3000 + -400 + -50 = -3450
      expect(frame).toContain('-$3,450');
    });
  });

  it('Esc cancels an in-progress cell edit without committing', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    r.stdin.write('\x1B[B'); await tick(); // r1:amount
    r.stdin.write('\r');     await tick();
    expect(r.lastFrame()).toContain('-2000');
    r.stdin.write('9');      await tick();
    r.stdin.write('\x1B');   // Esc
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('-$2,000');
      expect(frame).not.toContain('-20009');
    });
  });

  it('edits the label cell as free text', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    r.stdin.write('\r'); await tick(); // r1:label already selected — Enter to edit "Rent"
    r.stdin.write('\x7F'); await tick();
    r.stdin.write('\x7F'); await tick();
    r.stdin.write('\x7F'); await tick();
    r.stdin.write('\x7F'); await tick(); // backspace x4 -> ""
    r.stdin.write('Mortgage'); await tick();
    r.stdin.write('\r');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('Mortgage');
      expect(frame).not.toContain('Rent');
    });
  });

  it('steps a start cell left past the minimum into "any" (unbounded), and back', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    const minYear = new Date().getFullYear() - 20;
    r.stdin.write('\x1B[B'); await tick(); // r1:label -> r1:amount
    r.stdin.write('\x1B[B'); await tick(); // r1:amount -> r1:start ("any")
    r.stdin.write('\x1B[C'); await tick(); // -> step right lands on MIN_ROW_YEAR
    await waitFor(() => expect(r.lastFrame()).toContain(String(minYear)));
    r.stdin.write('\x1B[D'); await tick(); // -> step left off the minimum lands on "any"
    await waitFor(() => expect(r.lastFrame()).toContain('any'));
  });

  it('steps an end cell right past the maximum into "ongoing", and back', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    const maxYear = new Date().getFullYear() + 50;
    for (let i = 0; i < 3; i++) { r.stdin.write('\x1B[B'); await tick(); } // r1:label -> ... -> r1:end ("ongoing")
    r.stdin.write('\x1B[D'); await tick(); // -> step left lands on MAX_ROW_YEAR
    await waitFor(() => expect(r.lastFrame()).toContain(String(maxYear)));
    r.stdin.write('\x1B[C'); await tick(); // -> step right off the maximum lands on "ongoing"
    await waitFor(() => expect(r.lastFrame()).toContain('ongoing'));
  });

  it('Enter still opens a numeric edit buffer on a start cell, clamping a typed value on commit', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    const maxYear = new Date().getFullYear() + 50;
    r.stdin.write('\x1B[B'); await tick(); // r1:amount
    r.stdin.write('\x1B[B'); await tick(); // r1:start ("any")
    r.stdin.write('\r'); await tick(); // Enter — edit mode, buffer seeded "" (unbounded)
    // Type an absurdly large year — this is exactly the "bad year" input the
    // free-text field used to accept unchecked; commit must clamp it.
    for (const ch of String(maxYear + 999)) r.stdin.write(ch);
    await tick();
    r.stdin.write('\r'); // commit — clamps to MAX_ROW_YEAR
    await waitFor(() => expect(r.lastFrame()).toContain(String(maxYear)));
  });

  it('Enter on a bounded cell can be cleared back to unbounded by committing a blank buffer', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    // r1:label -> amount -> start -> end -> r2:label -> amount -> start -> r2:end
    // (r2 is bounded 2020-2026).
    for (let i = 0; i < 7; i++) { r.stdin.write('\x1B[B'); await tick(); }
    r.stdin.write('\r'); await tick(); // Enter — buffer seeded "2026"
    for (let i = 0; i < 4; i++) r.stdin.write('\x7F'); // backspace x4 -> ""
    await tick();
    r.stdin.write('\r'); // commit blank -> unbounded
    await waitFor(() => expect(r.lastFrame()).toContain('ongoing'));
  });

  it('sum_active still works with rows whose start or end is stepped to unbounded', async () => {
    const r = render(<CanvasView spec={LIST_SPEC} />);
    await waitFor(() => expect(r.lastFrame()).toContain('-$2,450'));
    // Move to r2:end (bounded 2020-2026, currently active for 2024) and step it
    // all the way past MAX_ROW_YEAR to "ongoing" — it should still be active
    // for 2024 afterward, so the total is unchanged.
    for (let i = 0; i < 7; i++) { r.stdin.write('\x1B[B'); await tick(); }
    const maxYear = new Date().getFullYear() + 50;
    const steps = maxYear - 2026 + 1;
    for (let i = 0; i < steps; i++) { r.stdin.write('\x1B[C'); await tick(); }
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).toContain('ongoing');
      expect(frame).toContain('-$2,450');
    });
  });

  it('persists a committed cell edit via updateHistoryEntrySpec + resolveAndWriteCanvasSpec', async () => {
    const { updateHistoryEntrySpec, resolveAndWriteCanvasSpec } = await import('../../core/canvas-history.js');
    vi.mocked(updateHistoryEntrySpec).mockClear();
    vi.mocked(resolveAndWriteCanvasSpec).mockClear();

    const specWithHistory: LoadedCanvasSpec = { ...LIST_SPEC, _historyId: 'hist-1' };
    const r = render(<CanvasView spec={specWithHistory} />);
    r.stdin.write('\x1B[B'); await tick(); // r1:amount
    r.stdin.write('\r');     await tick();
    expect(r.lastFrame()).toContain('-2000');
    r.stdin.write('0');      await tick();
    r.stdin.write('\r');
    await waitFor(() => expect(r.lastFrame()).toContain('-$20,000'));

    expect(updateHistoryEntrySpec).toHaveBeenCalledTimes(1);
    const [id, updatedSpec] = vi.mocked(updateHistoryEntrySpec).mock.calls[0];
    expect(id).toBe('hist-1');
    const savedList = updatedSpec.elements.find((e) => e.type === 'list');
    expect(savedList?.type === 'list' && savedList.list.rows.find((row) => row.id === 'r1')?.amount).toBe(-20000);

    expect(resolveAndWriteCanvasSpec).toHaveBeenCalledTimes(1);
  });

  it('does not persist when the spec has no _historyId (e.g. a hand-built or navigation-only spec)', async () => {
    const { updateHistoryEntrySpec, resolveAndWriteCanvasSpec } = await import('../../core/canvas-history.js');
    vi.mocked(updateHistoryEntrySpec).mockClear();
    vi.mocked(resolveAndWriteCanvasSpec).mockClear();

    const r = render(<CanvasView spec={LIST_SPEC} />);
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\r');     await tick();
    expect(r.lastFrame()).toContain('-2000');
    r.stdin.write('0');      await tick();
    r.stdin.write('\r');
    await waitFor(() => expect(r.lastFrame()).toContain('-$20,000'));

    expect(updateHistoryEntrySpec).not.toHaveBeenCalled();
    expect(resolveAndWriteCanvasSpec).not.toHaveBeenCalled();
  });
});

describe('CanvasView — list visibility via count()', () => {
  const EMPTY_STATE_SPEC: CanvasSpec = {
    title: 'Empty State Test',
    elements: [
      { type: 'list', list: { key: 'items', label: 'Items', rows: [] } },
      { type: 'text', content: 'No items yet — press [a] to add one.', visible: 'count(items) == 0' },
      { type: 'output', output: { label: 'Item count', expr: 'count(items)', format: 'integer' } },
    ],
  };

  it('shows the empty-state text while the list has no rows, and hides it once a row is added', async () => {
    const r = render(<CanvasView spec={EMPTY_STATE_SPEC} />);
    expect(r.lastFrame()).toContain('No items yet');

    // Cursor starts on the 'listAdd' placeholder stop since the list has 0 rows.
    r.stdin.write('a');
    await waitFor(() => {
      const frame = r.lastFrame() ?? '';
      expect(frame).not.toContain('No items yet');
      expect(frame).toContain('Item count');
      expect(frame).toContain('1');
    });
  });
});

// ─── CanvasView — chart/table elements (canvas issue #145, Effort C) ─────────
// Projections: one point per driver-dial step (see core/canvas-spec.ts's
// projectSeries()/ProjectionDef), rendered either as a plain aligned table or as
// a `bar()`-based row chart — reusing the same horizontal-bar idiom
// Dashboard/Trends already use, NOT a novel sparkline. Neither element type is a
// cursor stop: there's nothing to edit, same treatment `output` rows already get.

const CHART_SPEC: CanvasSpec = {
  title: 'Chart Test',
  elements: [
    { type: 'dial', dial: { key: 'years', label: 'Years', default: 0, step: 1, min: 0, max: 10, format: 'year', hint: 'years from now' } },
    {
      type: 'chart',
      chart: {
        label: 'Balance over time',
        driver: 'years',
        series: [{ label: 'Balance', expr: '20000 - years * 2000', format: 'dollar', color: 'negative' }],
      },
    },
  ],
};

describe('CanvasView — chart element', () => {
  it('renders one bar row per driver step, scaled relative to the series max', () => {
    const { lastFrame } = render(<CanvasView spec={CHART_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Balance over time');
    expect(frame).toContain('YEARS');
    expect(frame).toContain('BALANCE');

    const barLines = frame.split('\n').filter((l) => l.includes('█') || l.includes('░'));
    // driver range 0..10 step 1 -> 11 points -> 11 bar rows
    expect(barLines.length).toBe(11);
    // years=0 -> balance 20,000, the largest magnitude across every point ->
    // fully filled bar (20/20 blocks, BAR_WIDTH default since there's 1 series).
    expect(barLines[0]).toContain('█'.repeat(20));
    // years=10 -> balance 0 -> fully empty bar.
    expect(barLines[barLines.length - 1]).toContain('░'.repeat(20));
  });

  it('is not a cursor stop — navigating past the driver dial finds nowhere else to land', async () => {
    const r = render(<CanvasView spec={CHART_SPEC} />);
    // The only dial ("Years") is the sole cursor stop; an 11-point chart must
    // contribute zero additional stops. Repeated down-arrows should leave the
    // dial selected (its control hint still visible) rather than walking into
    // phantom chart-row stops.
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    expect(r.lastFrame()).toContain('← → ±1');
  });
});

const BAD_DRIVER_CHART_SPEC: CanvasSpec = {
  title: 'Bad Driver Test',
  elements: [
    { type: 'dial', dial: { key: 'years', label: 'Years', default: 0, step: 1, min: 0, max: 10, format: 'year', hint: 'years from now' } },
    {
      type: 'chart',
      chart: {
        label: 'Broken chart',
        driver: 'nonexistent', // no matching dial element -> projectSeries() returns []
        series: [{ label: 'Balance', expr: '20000', format: 'dollar' }],
      },
    },
  ],
};

describe('CanvasView — chart/table with an unresolvable driver', () => {
  it('renders a distinct "no data" state instead of crashing or rendering an empty chart/table', () => {
    expect(() => render(<CanvasView spec={BAD_DRIVER_CHART_SPEC} />)).not.toThrow();
    const { lastFrame } = render(<CanvasView spec={BAD_DRIVER_CHART_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Broken chart');
    expect(frame).toContain('No data');
    expect(frame).not.toContain('█');
  });
});

const TABLE_SPEC: CanvasSpec = {
  title: 'Table Test',
  elements: [
    { type: 'dial', dial: { key: 'year', label: 'Year', default: 2025, step: 1, min: 2025, max: 2027, format: 'year', hint: 'projection year' } },
    {
      type: 'table',
      table: {
        label: 'Net worth projection',
        driver: 'year',
        series: [
          { label: 'Net worth', expr: '(year - 2025) * 1000', format: 'dollar' },
          { label: 'Debt', expr: '5000 - (year - 2025) * 2000', format: 'dollar', signed: true },
        ],
      },
    },
  ],
};

describe('CanvasView — table element', () => {
  it('renders one row per driver step with correctly formatted driver/series values', () => {
    const { lastFrame } = render(<CanvasView spec={TABLE_SPEC} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Net worth projection');
    expect(frame).toContain('YEAR');
    expect(frame).toContain('NET WORTH');
    expect(frame).toContain('DEBT');

    // year 2025..2027 step 1 -> 3 points
    expect(frame).toContain(fmtDialValue(2025, 'year'));
    expect(frame).toContain(fmtDialValue(2026, 'year'));
    expect(frame).toContain(fmtDialValue(2027, 'year'));
    expect(frame).toContain(fmtValue(0, 'dollar'));           // net worth @2025
    expect(frame).toContain(fmtValue(1000, 'dollar'));        // net worth @2026
    expect(frame).toContain(fmtValue(2000, 'dollar'));        // net worth @2027
    expect(frame).toContain(fmtValue(5000, 'dollar', true));  // debt @2025 (signed)
    expect(frame).toContain(fmtValue(3000, 'dollar', true));  // debt @2026
    expect(frame).toContain(fmtValue(1000, 'dollar', true));  // debt @2027
    // a table has no bars, unlike a chart
    expect(frame).not.toContain('█');
    expect(frame).not.toContain('░');
  });

  it('right-aligns every row\'s driver column to the same column as the header', () => {
    const { lastFrame } = render(<CanvasView spec={TABLE_SPEC} />);
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const headerLine = lines.find((l) => l.includes('YEAR') && l.includes('NET WORTH') && l.includes('DEBT'));
    expect(headerLine).toBeDefined();

    // Every column is padStart()'d to one shared width (computed once across the
    // header and every row) and right-aligned, so the column's RIGHT edge lands
    // at the same character index on every row, header included — the same
    // invariant that kept list-row brackets aligned in the tests further above.
    const yearCol = headerLine!.indexOf('YEAR') + 'YEAR'.length;
    const driverValues = [fmtDialValue(2025, 'year'), fmtDialValue(2026, 'year'), fmtDialValue(2027, 'year')];
    // Exclude the "Year" dial's own row — it also renders 2025 (its default) but
    // inside a `[ ... ]` value bracket, unlike a plain table row.
    const dataLines = lines.filter((l) => l !== headerLine && !l.includes('[') && driverValues.some((v) => l.includes(v)));
    expect(dataLines.length).toBe(3);
    for (const line of dataLines) {
      const yearText = driverValues.find((v) => line.includes(v))!;
      expect(line.indexOf(yearText) + yearText.length).toBe(yearCol);
    }
  });

  it('is not a cursor stop — navigating past the driver dial finds nowhere else to land', async () => {
    const r = render(<CanvasView spec={TABLE_SPEC} />);
    r.stdin.write('\x1B[B'); await tick();
    r.stdin.write('\x1B[B'); await tick();
    expect(r.lastFrame()).toContain('← → ±1');
  });
});

// ─── Canvas — parent must not double-fire nav/Escape while CanvasView edits ──
// Regression test: Canvas() has its own useInput as a sibling of CanvasView's.
// Ink has no stopPropagation between independent useInput hooks, so both used
// to fire on every keypress — a digit typed into a dial/list-cell edit buffer
// also switched screens, and Escape to cancel an edit also navigated to the
// dashboard on the same keypress. Canvas() now tracks CanvasView's editMode via
// an onEditingChange callback and suppresses its own handling while editing.

const DIAL_SPEC: LoadedCanvasSpec = {
  title: 'Dial Test',
  elements: [
    { type: 'dial', dial: { key: 'amount', label: 'Amount', default: 100, step: 100, min: 0, format: 'dollar', hint: 'an amount' } },
  ],
};

describe('Canvas — suppresses digit-nav and Escape-to-dashboard while CanvasView is mid-edit', () => {
  it('typing digits into a dial edit buffer does not navigate to that digit\'s screen', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <Canvas onNavigate={onNavigate} onLoadSpec={() => {}} showHints={false} spec={DIAL_SPEC} specKey={0} />
    );
    r.stdin.write('\r'); await tick(); // Enter -> edit mode, buffer seeded "100"
    expect(r.lastFrame()).toContain('100');
    for (let i = 0; i < 3; i++) r.stdin.write('\x7F'); // clear "100"
    for (const ch of '2500') r.stdin.write(ch);
    await tick();
    expect(onNavigate).not.toHaveBeenCalled();
    r.stdin.write('\r'); // commit
    await waitFor(() => expect(r.lastFrame()).toContain('$2,500'));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('typing digits into a list-cell edit buffer does not navigate to that digit\'s screen', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <Canvas onNavigate={onNavigate} onLoadSpec={() => {}} showHints={false} spec={LIST_SPEC} specKey={0} />
    );
    r.stdin.write('\x1B[B'); await tick(); // r1:label -> r1:amount
    r.stdin.write('\r');     await tick(); // Enter -> edit mode, buffer seeded "-2000"
    for (let i = 0; i < 5; i++) r.stdin.write('\x7F');
    for (const ch of '-3000') r.stdin.write(ch);
    await tick();
    expect(onNavigate).not.toHaveBeenCalled();
    r.stdin.write('\r'); // commit
    await waitFor(() => expect(r.lastFrame()).toContain('-$3,000'));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Escape while editing cancels just the edit, without also navigating to the dashboard', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <Canvas onNavigate={onNavigate} onLoadSpec={() => {}} showHints={false} spec={DIAL_SPEC} specKey={0} />
    );
    r.stdin.write('\r'); await tick(); // enter edit mode, buffer "100"
    r.stdin.write('9');  await tick(); // buffer "1009"
    r.stdin.write('\x1B'); // Escape — cancel the edit
    await waitFor(() => expect(r.lastFrame()).toContain('$100')); // unchanged: edit was cancelled, not committed
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Escape when NOT editing still navigates to the dashboard, unchanged', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <Canvas onNavigate={onNavigate} onLoadSpec={() => {}} showHints={false} spec={DIAL_SPEC} specKey={0} />
    );
    r.stdin.write('\x1B'); // Escape, not editing
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard'));
  });

  it('digit-based screen switching still works outside edit mode', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <Canvas onNavigate={onNavigate} onLoadSpec={() => {}} showHints={false} spec={DIAL_SPEC} specKey={0} />
    );
    r.stdin.write('2'); // not editing -> digit nav to transactions
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('transactions'));
  });
});
