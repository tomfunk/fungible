// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../../core/canvas-history.js', () => ({
  loadHistory: () => [],
  deleteHistoryEntry: () => true,
  CANVAS_SPEC_PATH: '/tmp/fungible-test-nonexistent-canvas.json',
}));

import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Canvas, CanvasView } from '../../gui/renderer/src/screens/Canvas.js';
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

  it('bounded dials render sliders and respect max', async () => {
    renderScreen(<CanvasView spec={SPEC} />);
    const aprDial = screen.getByText('APR').closest('div')!.parentElement!;
    const slider = aprDial.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.max).toBe('40');
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
