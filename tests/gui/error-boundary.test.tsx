// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Keep App's canvas auto-open effect away from the developer's real ~/.fungible.
vi.mock('../../core/canvas-history.js', () => ({
  loadHistory: () => [],
  deleteHistoryEntry: () => true,
  CANVAS_SPEC_PATH: '/tmp/fungible-test-nonexistent-canvas.json',
}));

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge } from './helpers/renderGui.js';
import { registry } from '../../gui/main/registry.js';
import { App } from '../../gui/renderer/src/App.js';

beforeEach(async () => {
  localStorage.clear();
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
  // React logs the caught render error; it is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GUI screen error boundary', () => {
  it('a failed query shows the message, and Retry remounts the screen', async () => {
    vi.spyOn(registry.queries, 'getRangeSummary').mockRejectedValueOnce(new Error('boom'));
    render(<App />);
    expect(await screen.findByText('Something went wrong loading this screen.')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    expect(screen.queryByText('Something went wrong loading this screen.')).toBeNull();
    // the retried screen got past loading (the app opens on the current month,
    // which the May-2026 fixture has no data for)
    await waitFor(() => expect(screen.getByText('No expense data for this period.')).toBeTruthy());
  });

  it('Retry fails again if the query keeps failing, showing the new error', async () => {
    const spy = vi.spyOn(registry.queries, 'getRangeSummary')
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    render(<App />);
    expect(await screen.findByText('first')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('second')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('navigating via the sidebar resets the boundary', async () => {
    vi.spyOn(registry.queries, 'getRangeSummary').mockRejectedValueOnce(new Error('boom'));
    render(<App />);
    expect(await screen.findByText('boom')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Transactions' })).toBeTruthy());
    expect(screen.queryByText('Something went wrong loading this screen.')).toBeNull();
    // and going back to the Dashboard (the spy is spent) loads normally
    await userEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    expect(screen.queryByText('Something went wrong loading this screen.')).toBeNull();
  });
});
