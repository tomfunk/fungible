// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
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
