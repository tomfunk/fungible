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
  for (const tbl of ['transactions', 'accounts', 'categories', 'tags', 'transaction_tags',
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
});
