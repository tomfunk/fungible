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
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

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

describe('GUI Accounts', () => {
  it('lists linked accounts with masks and sync status', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    expect(screen.getByText('···0001')).toBeTruthy();
    expect(screen.getByText('Test Visa')).toBeTruthy();
    expect(screen.getByText('···0002')).toBeTruthy();
    expect(screen.getAllByText(/synced/).length).toBeGreaterThan(0);
  });

  it('edit modal saves a nickname shown with the ✎ marker', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByText('Test Checking'));
    await waitFor(() => expect(screen.getByPlaceholderText('none')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('none'), 'Daily Driver');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Updated Daily Driver')).toBeTruthy());
    await waitFor(() => {
      const cell = screen.getAllByText(/Daily Driver/).find((el) => el.closest('tr'));
      expect(cell?.closest('tr')!.textContent).toContain('✎');
    });
  });

  it('edit modal toggles "exclude from net worth", persisted with the ⊘ marker', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByText('Test Checking'));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Updated Test Checking')).toBeTruthy());
    await waitFor(() => {
      const cell = screen.getAllByText(/Test Checking/).find((el) => el.closest('tr'));
      expect(cell?.closest('tr')!.textContent).toContain('excl');
    });
  });

  it('add-data tab shows the four cards with Plaid unconfigured', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Add Data' }));
    await waitFor(() => expect(screen.getByText('Import CSV')).toBeTruthy());
    expect(screen.getByText('Manual asset')).toBeTruthy();
    expect(screen.getByText('Force sync')).toBeTruthy();
    expect(screen.getByText(/Plaid not configured/)).toBeTruthy();
  });

  it('creates a manual asset that appears in the table', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Add Data' }));
    await userEvent.click(await screen.findByText('Manual asset'));
    await userEvent.type(screen.getByPlaceholderText('e.g. "House", "Car"'), 'House');
    const valueInput = screen.getByText('Value $').closest('div')!.querySelectorAll('input')[1];
    await userEvent.type(valueInput, '500000');
    await userEvent.click(screen.getByRole('button', { name: 'Add asset' }));
    await waitFor(() => expect(screen.getByText('House added')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('House')).toBeTruthy());
  });

  it('delete flow requires confirmation and removes the account', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Visa')).toBeTruthy());
    const row = screen.getByText('Test Visa').closest('tr')!;
    await userEvent.click(Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'delete')!);
    await waitFor(() => expect(screen.getByText(/cannot be undone/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Test Visa')).toBeNull());
    expect(screen.getByText('Deleted Test Visa')).toBeTruthy();
  });

  it('dupes tab shows the empty state', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /^Dupes/ }));
    await waitFor(() => expect(screen.getByText('No duplicate candidates found.')).toBeTruthy());
  });
});
