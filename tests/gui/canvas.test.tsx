// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Recharts' ResponsiveContainer renders nothing at jsdom's zero size (see
// trends.test.tsx), so the chart internals can't be asserted against real SVG
// output. Mock the handful of recharts exports Canvas.tsx uses with simple
// stand-ins: ComposedChart exposes `data.length` and one clickable button per
// point (mirroring recharts' own onClick({ activeLabel }) contract so the
// component's real click-to-jump wiring is exercised, not reimplemented here),
// Line/Legend render a marker element so series count and legend presence are
// countable, and the rest are no-ops.
vi.mock('recharts', async () => {
  const React = await import('react');
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
    ComposedChart: ({
      data,
      onClick,
      children,
    }: {
      data: { x: number }[];
      onClick?: (state: { activeLabel: number }) => void;
      children?: React.ReactNode;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'chart', 'data-points': data.length },
        data.map((d, i) =>
          React.createElement(
            'button',
            { key: i, 'data-testid': `chart-point-${i}`, onClick: () => onClick?.({ activeLabel: d.x }) },
            `pt-${i}`,
          ),
        ),
        children,
      ),
    Line: ({ dataKey, name }: { dataKey: string; name: string }) =>
      React.createElement('div', { 'data-testid': 'chart-line', 'data-key': dataKey }, name),
    Legend: () => React.createElement('div', { 'data-testid': 'chart-legend' }),
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    CartesianGrid: () => null,
  };
});

vi.mock('../../core/canvas-history.js', () => ({
  loadHistory: () => [],
  deleteHistoryEntry: () => true,
  // Spies so list-element persistence tests can assert exactly when a commit
  // reaches disk (via registry.ts's canvas.updateSpec, which calls both in
  // sequence — see gui/main/registry.ts). Returning a plausible entry/spec keeps
  // registry.ts's own logic (it null-checks the update) happy.
  updateHistoryEntrySpec: vi.fn((id: string, spec: unknown) => ({
    id,
    spec,
    title: 'mock',
    prompt: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  })),
  resolveAndWriteCanvasSpec: vi.fn(async (spec: unknown) => spec),
  CANVAS_SPEC_PATH: '/tmp/fungible-test-nonexistent-canvas.json',
}));

import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Canvas, CanvasView } from '../../gui/renderer/src/screens/Canvas.js';
import { updateHistoryEntrySpec, resolveAndWriteCanvasSpec } from '../../core/canvas-history.js';
import { evalExpr } from '../../core/canvas-spec.js';
import type { CanvasSpec } from '../../core/canvas-spec.js';

const SPEC: CanvasSpec = {
  title: 'Credit Card Payoff',
  elements: [
    { type: 'section', label: 'INPUTS' },
    { type: 'text', content: 'Adjust the dials to model your payoff.' },
    { type: 'dial', dial: { key: 'balance', label: 'Balance', default: 20000, step: 500, min: 0, format: 'dollar', hint: 'current balance' } },
    { type: 'dial', dial: { key: 'rate', label: 'APR', default: 22, step: 0.5, min: 0, max: 40, format: 'percent', hint: 'annual rate' } },
    { type: 'dial', dial: { key: 'monthly', label: 'Monthly payment', default: 500, step: 50, min: 0, format: 'dollar', hint: 'what you pay' } },
    { type: 'section', label: 'RESULTS' },
    { type: 'output', output: { label: 'Months to payoff', expr: '-Math.log(1 - balance * rate/100/12 / monthly) / Math.log(1 + rate/100/12)', format: 'months', color: 'neutral' } },
  ],
};

beforeEach(() => {
  installBridge();
});

afterEach(() => cleanup());

describe('GUI CanvasView', () => {
  it('renders sections, text, dials and computed outputs', () => {
    renderScreen(<CanvasView spec={SPEC} />);
    expect(screen.getByText('Credit Card Payoff')).toBeTruthy();
    expect(screen.getByText('INPUTS')).toBeTruthy();
    expect(screen.getByText(/Adjust the dials/)).toBeTruthy();
    expect(screen.getByText('Balance')).toBeTruthy();
    expect(screen.getByText('$20,000')).toBeTruthy();
    expect(screen.getByText('Months to payoff')).toBeTruthy();
    // 20000 @ 22% APR with $500/mo → 72.8 months
    expect(screen.getByText('72.8 mo')).toBeTruthy();
  });

  it('stepping a dial recomputes outputs and offers reset', async () => {
    renderScreen(<CanvasView spec={SPEC} />);
    const monthlyDial = screen.getByText('Monthly payment').closest('div')!.parentElement!;
    const plus = Array.from(monthlyDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    expect(screen.getByText('$550')).toBeTruthy();
    expect(screen.queryByText('72.8 mo')).toBeNull(); // recomputed
    await userEvent.click(screen.getByText('reset'));
    expect(screen.getByText('$500')).toBeTruthy();
    expect(screen.getByText('72.8 mo')).toBeTruthy();
  });

  it('bounded dials render as a stepper and respect max', async () => {
    renderScreen(<CanvasView spec={SPEC} />);
    const aprDial = screen.getByText('APR').closest('div')!.parentElement!;
    const input = aprDial.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.max).toBe('40');
  });
});

const TOGGLE_SELECT_SPEC: CanvasSpec = {
  title: 'Extra Income',
  elements: [
    { type: 'dial', dial: { key: 'hasRaise', label: 'Got a raise?', default: 0, step: 1, format: 'toggle', hint: 'toggle raise' } },
    {
      type: 'dial',
      dial: {
        key: 'filingStatus',
        label: 'Filing status',
        default: 0,
        step: 1,
        format: 'select',
        hint: 'tax filing status',
        options: ['Single', 'Married filing jointly', 'Head of household'],
      },
    },
    { type: 'section', label: 'RAISE DETAILS', visible: 'hasRaise' },
    {
      type: 'dial',
      dial: { key: 'raiseAmount', label: 'Raise amount', default: 5000, step: 500, min: 0, format: 'dollar', hint: 'annual raise' },
      visible: 'hasRaise',
    },
    { type: 'output', output: { label: 'Status label', expr: 'filingStatus', format: 'integer', color: 'neutral' } },
  ],
};

describe('GUI CanvasView toggle/select dials and visible filtering', () => {
  it('renders a toggle dial as a checkbox and stores 0/1, with no redundant On/Off text', async () => {
    renderScreen(<CanvasView spec={TOGGLE_SELECT_SPEC} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByText('Off')).toBeNull();
    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByText('On')).toBeNull();
  });

  it('renders a select dial as a native select with options as the value', async () => {
    renderScreen(<CanvasView spec={TOGGLE_SELECT_SPEC} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('0');
    expect(screen.getAllByText('Single').length).toBeGreaterThan(0);
    await userEvent.selectOptions(select, '1');
    expect(select.value).toBe('1');
    expect(screen.getAllByText('Married filing jointly').length).toBeGreaterThan(0);
  });

  it('hides an element whose visible expression is false, excluding it from render', () => {
    renderScreen(<CanvasView spec={TOGGLE_SELECT_SPEC} />);
    expect(screen.queryByText('RAISE DETAILS')).toBeNull();
    expect(screen.queryByText('Raise amount')).toBeNull();
  });

  it('shows a visible-gated element once its condition becomes true, and freezes its value across hide/show', async () => {
    renderScreen(<CanvasView spec={TOGGLE_SELECT_SPEC} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    await userEvent.click(checkbox); // hasRaise -> 1
    expect(screen.getByText('RAISE DETAILS')).toBeTruthy();
    expect(screen.getByText('Raise amount')).toBeTruthy();

    // change the now-visible dial away from its default
    const raiseDial = screen.getByText('Raise amount').closest('div')!.parentElement!;
    const plus = Array.from(raiseDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    expect(screen.getByText('$5,500')).toBeTruthy();

    // hide it again
    await userEvent.click(checkbox); // hasRaise -> 0
    expect(screen.queryByText('Raise amount')).toBeNull();

    // reshow — value should have survived (frozen), not reset to the 5000 default
    await userEvent.click(checkbox); // hasRaise -> 1
    expect(screen.getByText('$5,500')).toBeTruthy();
  });
});

// core/canvas-spec.ts's expression grammar now supports real `&&`/`||` logical
// operators (previously it had none: `&` wasn't even tokenized, so
// `has_option == 1 && strategy == 1` threw a parse error, evalExpr() caught it
// and returned NaN, and per the documented "fails OPEN" convention (NaN !== 0
// is true) the element rendered as ALWAYS VISIBLE regardless of dial values —
// the opposite of the intended AND gate). This is now fixed; see the
// regression test below and the natural `&&` used directly in
// CHAINED_VISIBLE_SPEC's `strategy_detail` dial.
//
// Three-level chain: has_option (toggle) gates whether `strategy` (select) renders
// at all, and `strategy`'s own chosen option in turn gates whether `strategy_detail`
// renders.
const CHAINED_VISIBLE_SPEC: CanvasSpec = {
  title: 'Chained visibility',
  elements: [
    { type: 'dial', dial: { key: 'has_option', label: 'Enable strategy?', default: 0, step: 1, format: 'toggle', hint: 'toggle' } },
    {
      type: 'dial',
      dial: {
        key: 'strategy',
        label: 'Strategy',
        default: 0,
        step: 1,
        format: 'select',
        hint: 'pick a strategy',
        options: ['Conservative', 'Aggressive'],
      },
      visible: 'has_option == 1',
    },
    {
      type: 'dial',
      dial: { key: 'strategy_detail', label: 'Strategy detail', default: 42, step: 1, min: 0, format: 'integer', hint: 'detail dial' },
      visible: 'has_option == 1 && strategy == 1',
    },
  ],
};

describe('GUI CanvasView chained visible condition uses real && instead of the nested-ternary workaround', () => {
  it('`&&` in a `visible` expression behaves as a logical AND, identically to the old nested-ternary equivalent', () => {
    const expr = 'has_option == 1 && strategy == 1';
    expect(evalExpr(expr, { has_option: 0, strategy: 0 })).toBe(0);
    expect(evalExpr(expr, { has_option: 1, strategy: 0 })).toBe(0);
    expect(evalExpr(expr, { has_option: 0, strategy: 1 })).toBe(0);
    expect(evalExpr(expr, { has_option: 1, strategy: 1 })).toBe(1);

    // same truth table as the nested-ternary workaround this expression replaces
    const nestedTernaryEquivalent = 'has_option == 1 ? (strategy == 1 ? 1 : 0) : 0';
    expect(evalExpr(expr, { has_option: 0, strategy: 0 })).toBe(evalExpr(nestedTernaryEquivalent, { has_option: 0, strategy: 0 }));
    expect(evalExpr(expr, { has_option: 1, strategy: 0 })).toBe(evalExpr(nestedTernaryEquivalent, { has_option: 1, strategy: 0 }));
    expect(evalExpr(expr, { has_option: 0, strategy: 1 })).toBe(evalExpr(nestedTernaryEquivalent, { has_option: 0, strategy: 1 }));
    expect(evalExpr(expr, { has_option: 1, strategy: 1 })).toBe(evalExpr(nestedTernaryEquivalent, { has_option: 1, strategy: 1 }));
  });
});

describe('GUI CanvasView chained visible conditions (toggle -> select -> dial)', () => {
  it('hides both the select and the detail dial while the toggle is off', () => {
    renderScreen(<CanvasView spec={CHAINED_VISIBLE_SPEC} />);
    expect(screen.queryByText('Strategy')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Strategy detail')).toBeNull();
  });

  it('shows the select once the toggle is on, but keeps the detail dial hidden on option 0', async () => {
    renderScreen(<CanvasView spec={CHAINED_VISIBLE_SPEC} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    await userEvent.click(checkbox); // has_option -> 1

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('0');
    expect(screen.queryByText('Strategy detail')).toBeNull();
  });

  it('reveals the detail dial only once the select is switched to option 1', async () => {
    renderScreen(<CanvasView spec={CHAINED_VISIBLE_SPEC} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    await userEvent.click(checkbox); // has_option -> 1
    const select = screen.getByRole('combobox') as HTMLSelectElement;

    await userEvent.selectOptions(select, '1'); // strategy -> 1 (Aggressive)
    expect(screen.getByText('Strategy detail')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('hides both select and detail dial immediately when the toggle is flipped back off, and freezes the detail value', async () => {
    renderScreen(<CanvasView spec={CHAINED_VISIBLE_SPEC} />);
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    await userEvent.click(checkbox); // has_option -> 1
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, '1'); // strategy -> 1, detail dial appears

    // change the now-visible detail dial away from its default
    const detailDial = screen.getByText('Strategy detail').closest('div')!.parentElement!;
    const plus = Array.from(detailDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    expect(screen.getByText('43')).toBeTruthy();

    // flip the toggle off — both select and detail dial vanish immediately
    await userEvent.click(checkbox); // has_option -> 0
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Strategy detail')).toBeNull();

    // flip back on with strategy still at option 1 (frozen, not reset) — the detail
    // dial reappears and its value survived the hide/show round trip
    await userEvent.click(checkbox); // has_option -> 1
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('1');
    expect(screen.getByText('Strategy detail')).toBeTruthy();
    expect(screen.getByText('43')).toBeTruthy();
  });
});

const CROSS_OUTPUT_SPEC: CanvasSpec = {
  title: 'Cross-output references',
  elements: [
    { type: 'dial', dial: { key: 'balance', label: 'Balance', default: 1000, step: 100, min: 0, format: 'dollar', hint: 'balance' } },
    { type: 'output', output: { label: 'Doubled', expr: 'balance * 2', format: 'dollar', color: 'neutral', key: 'doubled' } },
    { type: 'output', output: { label: 'Doubled plus 5', expr: 'doubled + 5', format: 'dollar', color: 'neutral' } },
    { type: 'output', output: { label: 'Broken ref', expr: 'notAKey + 1', format: 'dollar', color: 'neutral' } },
  ],
};

const HIDDEN_OUTPUT_REF_SPEC: CanvasSpec = {
  title: 'Hidden output reference',
  elements: [
    { type: 'dial', dial: { key: 'balance', label: 'Balance', default: 1000, step: 100, min: 0, format: 'dollar', hint: 'balance' } },
    { type: 'output', output: { label: 'Hidden helper', expr: 'balance * 2', format: 'dollar', color: 'neutral', key: 'helper' }, visible: '0' },
    { type: 'output', output: { label: 'Visible total', expr: 'helper + 1', format: 'dollar', color: 'neutral' } },
  ],
};

describe('GUI CanvasView cross-output references', () => {
  it('a later output can reference an earlier output by key', () => {
    renderScreen(<CanvasView spec={CROSS_OUTPUT_SPEC} />);
    expect(screen.getByText('Doubled')).toBeTruthy();
    expect(screen.getByText('$2,000.00')).toBeTruthy(); // balance * 2
    expect(screen.getByText('Doubled plus 5')).toBeTruthy();
    expect(screen.getByText('$2,005.00')).toBeTruthy(); // doubled + 5
  });

  it('an output referencing a nonexistent key renders — instead of crashing', () => {
    renderScreen(<CanvasView spec={CROSS_OUTPUT_SPEC} />);
    expect(screen.getByText('Broken ref')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('a hidden output still computes and is referenceable by a later visible output', () => {
    renderScreen(<CanvasView spec={HIDDEN_OUTPUT_REF_SPEC} />);
    expect(screen.queryByText('Hidden helper')).toBeNull(); // excluded from render
    expect(screen.getByText('Visible total')).toBeTruthy();
    expect(screen.getByText('$2,001.00')).toBeTruthy(); // helper (1000*2) + 1
  });
});

describe('GUI Canvas screen', () => {
  it('shows the empty state and history panel', async () => {
    renderScreen(<Canvas />);
    await waitFor(() => expect(screen.getByText(/No canvas yet/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /history \(0\)/ }));
    await waitFor(() => expect(screen.getByText('No canvases found.')).toBeTruthy());
  });

  it('loads a spec from the canvasSpec nav payload', async () => {
    renderScreen(<Canvas />, { txFilter: { canvasSpec: JSON.stringify(SPEC) } });
    await waitFor(() => expect(screen.getByText('Credit Card Payoff')).toBeTruthy());
    expect(screen.getByText('Months to payoff')).toBeTruthy();
  });
});

const LIST_SPEC: CanvasSpec = {
  title: 'Recurring Expenses',
  elements: [
    { type: 'dial', dial: { key: 'year', label: 'Year', default: 2026, step: 1, format: 'year', hint: 'evaluation year' } },
    {
      type: 'list',
      list: {
        key: 'expenses',
        label: 'Recurring expenses',
        amountFormat: 'dollar',
        rows: [
          { id: 'expenses_0', label: 'Rent', amount: 2000 },
          { id: 'expenses_1', label: 'Car payment', amount: 400, startYear: 2020, endYear: 2028 },
        ],
      },
    },
    { type: 'output', output: { label: 'Active total', expr: 'sum_active(expenses.amount, year)', format: 'dollar', color: 'neutral' } },
    { type: 'output', output: { label: 'Row count', expr: 'count(expenses)', format: 'integer', color: 'neutral' } },
  ],
};

function rowCountText(): string | null {
  return screen.getByText('Row count').closest('div')!.querySelector('.num')!.textContent;
}

describe('GUI CanvasView list element', () => {
  it('renders each row as inline-editable label/amount/year fields', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    expect(screen.getByText('Recurring expenses')).toBeTruthy();
    expect(screen.getByDisplayValue('Rent')).toBeTruthy();
    expect(screen.getByDisplayValue('Car payment')).toBeTruthy();
    expect(screen.getByDisplayValue('2000')).toBeTruthy();
    expect(screen.getByDisplayValue('400')).toBeTruthy();
    expect(screen.getByDisplayValue('2020')).toBeTruthy();
    expect(screen.getByDisplayValue('2028')).toBeTruthy();
    // both active in 2026: 2000 + 400
    expect(screen.getByText('$2,400.00')).toBeTruthy();
    expect(rowCountText()).toBe('2');
  });

  it('adding a row appends a fresh, empty, editable row', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    await userEvent.click(screen.getByText('+ add row'));
    const labelInputs = screen.getAllByPlaceholderText('Label');
    expect(labelInputs.length).toBe(3);
    expect((labelInputs[2] as HTMLInputElement).value).toBe('');
    expect(rowCountText()).toBe('3');
  });

  it('removing a row drops it from render and recomputes dependent outputs', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Car payment' }));
    expect(screen.queryByDisplayValue('Car payment')).toBeNull();
    expect(screen.getByText('$2,000.00')).toBeTruthy(); // only Rent (2000) left
    expect(rowCountText()).toBe('1');
  });

  it('editing a cell updates its value and recomputes a sum_active output live', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const amountInput = screen.getByDisplayValue('2000') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '3000' } });
    expect(screen.getByDisplayValue('3000')).toBeTruthy();
    expect(screen.getByText('$3,400.00')).toBeTruthy(); // 3000 + 400
  });

  it('start/end year fields carry proper min/max bounds and still accept direct typing', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const currentYear = new Date().getFullYear();
    const startInput = screen.getByDisplayValue('2020') as HTMLInputElement;
    const endInput = screen.getByDisplayValue('2028') as HTMLInputElement;
    expect(startInput.min).toBe(String(currentYear - 20));
    expect(startInput.max).toBe(String(currentYear + 50));
    expect(endInput.min).toBe(String(currentYear - 20));
    expect(endInput.max).toBe(String(currentYear + 50));
    // direct typing still works — it isn't a step-only control
    fireEvent.change(startInput, { target: { value: '2021' } });
    expect(screen.getByDisplayValue('2021')).toBeTruthy();
  });

  it('typing an out-of-range year clamps into bounds instead of accepting it', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const currentYear = new Date().getFullYear();
    const startInput = screen.getByDisplayValue('2020') as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: '99999' } });
    expect(screen.getByDisplayValue(String(currentYear + 50))).toBeTruthy();

    const endInput = screen.getByDisplayValue('2028') as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: '-5' } });
    expect(screen.getByDisplayValue(String(currentYear - 20))).toBeTruthy();
  });

  it('stepping the start year down past the minimum clears it to "no bound", and back up restores the minimum', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - 20;
    const startInput = screen.getByDisplayValue('2020') as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: String(minYear) } });
    expect(screen.getByDisplayValue(String(minYear))).toBeTruthy();

    const decrease = screen.getByRole('button', { name: 'Decrease Car payment start year' });
    await userEvent.click(decrease);
    const startField = decrease.closest('div')!.querySelector('input') as HTMLInputElement;
    expect(startField.value).toBe('');

    const increase = screen.getByRole('button', { name: 'Increase Car payment start year' });
    await userEvent.click(increase);
    expect(screen.getByDisplayValue(String(minYear))).toBeTruthy();
  });

  it('stepping the end year up past the maximum clears it to "no bound", and back down restores the maximum', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const currentYear = new Date().getFullYear();
    const maxYear = currentYear + 50;
    const endInput = screen.getByDisplayValue('2028') as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: String(maxYear) } });
    expect(screen.getByDisplayValue(String(maxYear))).toBeTruthy();

    const increase = screen.getByRole('button', { name: 'Increase Car payment end year' });
    await userEvent.click(increase);
    const endField = increase.closest('div')!.querySelector('input') as HTMLInputElement;
    expect(endField.value).toBe('');

    const decrease = screen.getByRole('button', { name: 'Decrease Car payment end year' });
    await userEvent.click(decrease);
    expect(screen.getByDisplayValue(String(maxYear))).toBeTruthy();
  });

  it('a sum_active output still recomputes correctly for a row with an unbounded start or end', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    // Car payment (400) currently bounded 2020-2028, active in the dial's 2026.
    // Clear its end bound entirely (step past the max) — it should stay active,
    // and the sum_active output should keep counting it.
    const endInput = screen.getByDisplayValue('2028') as HTMLInputElement;
    const currentYear = new Date().getFullYear();
    fireEvent.change(endInput, { target: { value: String(currentYear + 50) } });
    const increase = screen.getByRole('button', { name: 'Increase Car payment end year' });
    await userEvent.click(increase);
    const endField = increase.closest('div')!.querySelector('input') as HTMLInputElement;
    expect(endField.value).toBe('');
    expect(screen.getByText('$2,400.00')).toBeTruthy(); // still 2000 + 400, now with an open-ended row
  });
});

describe('GUI CanvasView list element persistence', () => {
  beforeEach(() => {
    vi.mocked(updateHistoryEntrySpec).mockClear();
    vi.mocked(resolveAndWriteCanvasSpec).mockClear();
  });

  it('does not persist on every keystroke, only once the field is committed (blur)', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} historyId="hist-1" />);
    const amountInput = screen.getByDisplayValue('2000') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '3000' } });
    expect(updateHistoryEntrySpec).not.toHaveBeenCalled();
    fireEvent.blur(amountInput);
    expect(updateHistoryEntrySpec).toHaveBeenCalledTimes(1);
    expect(resolveAndWriteCanvasSpec).toHaveBeenCalledTimes(1);
    const [calledId, calledSpec] = vi.mocked(updateHistoryEntrySpec).mock.calls[0] as [string, CanvasSpec];
    expect(calledId).toBe('hist-1');
    const listEl = calledSpec.elements.find((el) => el.type === 'list');
    expect(listEl && listEl.type === 'list' ? listEl.list.rows[0].amount : undefined).toBe(3000);
  });

  it('persists immediately on add and on remove, each a single call', async () => {
    renderScreen(<CanvasView spec={LIST_SPEC} historyId="hist-1" />);
    await userEvent.click(screen.getByText('+ add row'));
    expect(updateHistoryEntrySpec).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Rent' }));
    expect(updateHistoryEntrySpec).toHaveBeenCalledTimes(2);
  });

  it('edits still apply locally, without persisting, when no historyId is available', () => {
    renderScreen(<CanvasView spec={LIST_SPEC} />);
    const amountInput = screen.getByDisplayValue('2000') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '3000' } });
    fireEvent.blur(amountInput);
    expect(screen.getByDisplayValue('3000')).toBeTruthy();
    expect(updateHistoryEntrySpec).not.toHaveBeenCalled();
  });
});

// years walks 0..3 step 1 -> 4 points; balance = rate * years = 0, 5, 10, 15
// (double = 0, 10, 20, 30 on the chart's second series only).
const PROJECTION_SPEC: CanvasSpec = {
  title: 'Projection Demo',
  elements: [
    { type: 'dial', dial: { key: 'years', label: 'Years out', default: 0, step: 1, min: 0, max: 3, format: 'integer', hint: 'years out' } },
    { type: 'dial', dial: { key: 'rate', label: 'Rate', default: 5, step: 1, min: 0, format: 'dollar', hint: 'per year' } },
    {
      type: 'chart',
      chart: {
        label: 'Balance chart',
        driver: 'years',
        series: [
          { label: 'Balance', expr: 'rate * years', format: 'dollar', color: 'positive' },
          { label: 'Double', expr: 'rate * years * 2', format: 'dollar', color: 'accent' },
        ],
      },
    },
    {
      type: 'table',
      table: {
        label: 'Balance table',
        driver: 'years',
        series: [{ label: 'Balance', expr: 'rate * years', format: 'dollar', color: 'positive' }],
      },
    },
  ],
};

const EMPTY_PROJECTION_SPEC: CanvasSpec = {
  title: 'Broken Projection',
  elements: [
    { type: 'chart', chart: { label: 'Broken chart', driver: 'nonexistent', series: [{ label: 'X', expr: '1', format: 'dollar' }] } },
    { type: 'table', table: { label: 'Broken table', driver: 'nonexistent', series: [{ label: 'X', expr: '1', format: 'dollar' }] } },
  ],
};

// "Years out" also appears inside the chart's "Click a point to move…" caption,
// so pick the label whose immediate sibling is the dial's own formatted-value
// span (DialRow renders label+value as siblings inside one header div) rather
// than assuming there's only one match.
function yearsDialValue(): string | null {
  const label = screen.getAllByText('Years out').find((el) => el.parentElement?.querySelector('.num'));
  return label!.parentElement!.querySelector('.num')!.textContent;
}

describe('GUI CanvasView chart element', () => {
  it('renders one point per driver step and one line per series', () => {
    renderScreen(<CanvasView spec={PROJECTION_SPEC} />);
    expect(screen.getByText('Balance chart')).toBeTruthy();
    const chart = screen.getByTestId('chart');
    expect(chart.getAttribute('data-points')).toBe('4');
    expect(screen.getAllByTestId('chart-line').length).toBe(2);
    expect(screen.getByTestId('chart-legend')).toBeTruthy(); // >1 series
  });

  it('clicking a chart point moves the driver dial to that point\'s value', async () => {
    renderScreen(<CanvasView spec={PROJECTION_SPEC} />);
    expect(yearsDialValue()).toBe('0');
    await userEvent.click(screen.getByTestId('chart-point-2')); // x=2 (0,1,2,3)
    expect(yearsDialValue()).toBe('2');
  });
});

describe('GUI CanvasView table element', () => {
  it('renders one row per driver step with correctly formatted values', () => {
    renderScreen(<CanvasView spec={PROJECTION_SPEC} />);
    expect(screen.getByText('Balance table')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getByText('$10.00').className).toContain('pos'); // color: 'positive'
    // header + 4 data rows
    expect(screen.getAllByRole('row').length).toBe(5);
  });

  it('clicking a table row moves the driver dial to that row\'s value', async () => {
    renderScreen(<CanvasView spec={PROJECTION_SPEC} />);
    expect(yearsDialValue()).toBe('0');
    await userEvent.click(screen.getByText('$10.00').closest('tr')!); // years=2
    expect(yearsDialValue()).toBe('2');
  });
});

describe('GUI CanvasView empty projection', () => {
  it('renders a no-data state instead of an empty chart/table shell', () => {
    renderScreen(<CanvasView spec={EMPTY_PROJECTION_SPEC} />);
    expect(screen.getByText('Broken chart')).toBeTruthy();
    expect(screen.getByText('Broken table')).toBeTruthy();
    expect(screen.getAllByText(/No data available/).length).toBe(2);
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
