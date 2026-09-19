// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen, MAY_FILTER } from './helpers/renderGui.js';
import { Dashboard } from '../../gui/renderer/src/screens/Dashboard.js';

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Dashboard', () => {
  it('shows income/expenses/net from seeded May data', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    // Income $3,500; expenses 120+85+45+95+43.99 = $388.99; net +$3,111.01
    await waitFor(() => expect(screen.getByText('$3,500.00')).toBeTruthy());
    expect(screen.getByText('$388.99')).toBeTruthy();
    expect(screen.getByText('+$3,111.01')).toBeTruthy();
  });

  it('lists categories with Grocery on top and navigates on click', async () => {
    const navigate = vi.fn();
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER, navigate });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByText('Grocery'));
    // The category lands in the shared filter; nav carries period (range +
    // anchor=from) and drillFrom so Esc can restore the same month.
    expect(navigate).toHaveBeenCalledWith(
      'transactions',
      expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01', drillFrom: 'dashboard',
      }),
    );
  });

  it('flex tab shows flexibility tiers', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Flexibility' }));
    await waitFor(() => expect(screen.getByText('Fixed')).toBeTruthy());
    expect(screen.getByText('Flexible')).toBeTruthy();
    expect(screen.getByText('Discretionary')).toBeTruthy();
  });

  it('flex tier click outbound payload carries range + anchor', async () => {
    const navigate = vi.fn();
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER, navigate });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Flexibility' }));
    await waitFor(() => expect(screen.getByText('Flexible')).toBeTruthy());
    await userEvent.click(screen.getByText('Flexible'));
    // No selectedAccount → no drillFrom, but range/anchor still travel so
    // Esc preserves the dashboard's month.
    expect(navigate).toHaveBeenCalledWith(
      'transactions',
      expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01', flex: 'flexible',
      }),
    );
  });

  it('scorecard mode buckets categories vs the typical-month baseline', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Δ scorecard' }));

    const section = await waitFor(() => {
      const s = screen.getByText(/Spending by category · vs typical/).closest('section')!;
      expect(s.textContent).toContain('Over');
      return s;
    });
    // Grocery: May $205 vs April-only baseline $100 → over by $105.
    // Bills & Utilities: $95 with no history → over, ratio shows "n/a".
    // Dining (+$5) and Shopping ($43.99, no baseline) sit under the
    // significance gate → typical. Nothing is under → no Under section.
    expect(section.textContent).toContain('+$105');
    expect(section.textContent).toContain('+$95');
    expect(section.textContent).toContain('n/a');
    expect(section.textContent).toContain('Typical');
    expect(section.textContent).not.toContain('Under');
    // Net row: 105 + 5 + 95 + 43.99 ≈ +$249 vs typical.
    expect(section.textContent).toContain('+$249');
    expect(section.textContent).toContain('vs typical');
  });

  it('scorecard rows drill to transactions like category rows', async () => {
    const navigate = vi.fn();
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER, navigate });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Δ scorecard' }));
    await waitFor(() => expect(screen.getByText('Over')).toBeTruthy());
    await userEvent.click(screen.getByText('Grocery'));
    expect(navigate).toHaveBeenCalledWith(
      'transactions',
      expect.objectContaining({ from: '2026-05-01', to: '2026-05-31', drillFrom: 'dashboard' }),
    );
  });

  it('columns toggle switches to the sortable per-baseline delta table', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Δ scorecard' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'columns' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'columns' }));
    // The diagnostic table has the three baseline columns; the scorecard doesn't.
    await waitFor(() => expect(screen.getByText(/vs prev/)).toBeTruthy());
    expect(screen.getByText(/yr ago/)).toBeTruthy();
    expect(screen.getByText(/12m avg/)).toBeTruthy();
  });

  it('mounts with scorecard mode on when navigated with scorecard: true', async () => {
    renderScreen(<Dashboard />, { txFilter: { ...MAY_FILTER, scorecard: true } });
    await waitFor(() => expect(screen.getByText(/Spending by category · vs typical/)).toBeTruthy());
  });

  it('Spending by category rows sum to the displayed Expenses total', async () => {
    // Exercise the two cases that used to break reconciliation: a refund inside a
    // real category (must NET to 200) and an income+spend mix inside Uncategorized
    // (must SPLIT — the $500 spend shows, the $2000 inflow is income, not netted away).
    await db.batch([
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel',        'test-credit',   '2026-05-04', 'United',        300.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel-refund', 'test-credit',   '2026-05-05', 'United Refund', -100.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-uncat-spend',   'test-credit',   '2026-05-07', 'Mystery Shop',  500.00, 'Uncategorized', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-uncat-income',  'test-checking', '2026-05-02', 'Side Gig',     -2000.00, 'Uncategorized', 0, 0)`,
    ], 'write');

    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());

    const parse = (t: string | null) => parseFloat((t ?? '').replace(/[^0-9.-]/g, ''));

    // Expenses card: its label's card holds the value in a `.num` element.
    const expensesCard = screen.getByText('Expenses').parentElement!;
    const expenses = parse(expensesCard.querySelector('.num')!.textContent);

    // Category rows: each row's amount cell is the global `td.num`.
    const section = screen.getByText('Spending by category').closest('section')!;
    expect(section.textContent).toContain('Uncategorized'); // the spend row must be present
    const categoryTotal = [...section.querySelectorAll('tbody tr')]
      .map((tr) => parse(tr.querySelector('td.num')!.textContent))
      .reduce((sum, n) => sum + n, 0);

    expect(expenses).toBeCloseTo(1088.99, 2);          // 388.99 seeded + 200 net Travel + 500 uncat
    expect(categoryTotal).toBeCloseTo(expenses, 2);    // detailed lines reconcile to the total
  });

  it('shows a colored income drift badge next to Income in scorecard mode', async () => {
    // April income (the only rolling-window baseline) is seeded at $3,500.
    // Push May to $4,500 so the delta (+$1,000) clears the significance gate.
    await db.batch([
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-income-bonus', 'test-checking', '2026-05-15', 'Bonus Deposit', -1000.00, 'Income', 0, 0)`,
    ], 'write');

    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await waitFor(() => expect(screen.getByText('$4,500.00')).toBeTruthy());

    // Not in scorecard mode yet: no badge.
    expect(screen.queryByText('+$1,000')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Δ scorecard' }));

    const badge = await waitFor(() => screen.getByText('+$1,000'));
    // Income above the median is the good outcome, so the badge reads green
    // ('pos'), unlike spending drift where above-median reads red.
    expect(badge.className).toContain('pos');
    expect(badge.closest('div')!.textContent).toContain('$4,500.00');
  });
});
