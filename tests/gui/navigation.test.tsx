// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import { App } from '../../gui/renderer/src/App.js';

beforeEach(async () => {
  localStorage.clear();
  for (const tbl of ['transactions', 'accounts', 'categories', 'tags', 'transaction_tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

describe('GUI App navigation', () => {
  it('sidebar clicks switch screens', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Transactions' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Net Worth' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Net Worth' })).toBeTruthy());
  });

  it('digit keys navigate when the keys toggle is on', async () => {
    localStorage.setItem('fungible-keys', 'on');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    fireEvent.keyDown(window, { key: '3' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Trends' })).toBeTruthy());
    fireEvent.keyDown(window, { key: '0' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy());
  });

  it('digit keys are inert when the keys toggle is off', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    fireEvent.keyDown(window, { key: '3' });
    expect(screen.queryByRole('heading', { name: 'Trends' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
  });

  it('keys toggle shows digit badges and hint lines', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    expect(screen.queryByText(/\[1-9·0\] screens/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Keys off/ }));
    await waitFor(() => expect(screen.getByText(/\[1-9·0\] screens/)).toBeTruthy());
    const transactionsNav = screen.getByRole('button', { name: /Transactions/ });
    expect(transactionsNav.textContent).toContain('2');
  });

  it('theme toggle flips the document theme and persists', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('fungible-theme')).toBe('light');
  });

  it('FilterBar appears on filterable screens only', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    expect(screen.getByText(/⚲ Filter/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy());
    expect(screen.queryByText(/⚲ Filter/)).toBeNull();
  });

  it('filter panel constrains categories and carries across screens', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    await userEvent.click(screen.getByText(/⚲ Filter/));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Grocery' })).toBeTruthy());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Grocery' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByText(/Filter: 4 categories/)).toBeTruthy());
    // carries to Transactions: Grocery rows excluded
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    expect(screen.queryByText('Trader Joes')).toBeNull();
    // clear restores
    await userEvent.click(screen.getByText('clear'));
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
  });

  it('toggling a category in the panel live-previews the screen behind it', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByText(/⚲ Filter/));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Grocery' })).toBeTruthy());
    // Toggle Grocery off — the underlying transaction list should repaint
    // before Apply is clicked (debounce is 120ms, well under waitFor's window).
    await userEvent.click(screen.getByRole('checkbox', { name: 'Grocery' }));
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    expect(screen.queryByText('Trader Joes')).toBeNull();
  });

  it('Cancel reverts the live preview without committing', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Transactions' }));
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByText(/⚲ Filter/));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Grocery' })).toBeTruthy());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Grocery' }));
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Preview clears on unmount → list reverts to the committed (empty) filter.
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    expect(screen.queryByText(/Filter: \d+ categories/)).toBeNull();
  });

  it('agent drawer collapsed bar shows no-key state and expands', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no API key set/)).toBeTruthy());
    await userEvent.click(screen.getByText(/no API key set/));
    await waitFor(() => expect(screen.getByText(/No API key — add ANTHROPIC_API_KEY/)).toBeTruthy());
  });
});
