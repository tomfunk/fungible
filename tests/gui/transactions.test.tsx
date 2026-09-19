// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Transactions } from '../../gui/renderer/src/screens/Transactions.js';

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

describe('GUI Transactions', () => {
  it('renders all seeded transactions with count', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    expect(screen.getAllByText('Whole Foods')).toHaveLength(2); // May + April
    expect(screen.getByText('Trader Joes')).toBeTruthy();
    expect(screen.getAllByText('Direct Deposit')).toHaveLength(2);
  });

  it('respects a category shared filter and shows a removable chip', async () => {
    renderScreen(<Transactions />, { initialFilter: { categories: ['Grocery'] } });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    const chip = screen.getByText('Grocery', { selector: 'span' });
    expect(chip).toBeTruthy();
    await userEvent.click(chip.querySelector('button')!);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
  });

  it('Escape steps the shared filter back (clears when history is empty)', async () => {
    localStorage.setItem('fungible-keys', 'on');
    renderScreen(<Transactions />, { initialFilter: { categories: ['Grocery'] } });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    localStorage.removeItem('fungible-keys');
  });

  it('Escape reversing a drill-in returns to the dashboard on the same month', async () => {
    localStorage.setItem('fungible-keys', 'on');
    const navigate = vi.fn();
    // Arrived here by drilling Grocery from the dashboard while viewing May 2026.
    renderScreen(<Transactions />, {
      txFilter: { from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-15', drillFrom: 'dashboard' },
      initialFilter: { categories: ['Grocery'] },
      navigate,
    });
    await waitFor(() => expect(screen.getByText(/\d+ transactions/)).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    // The month travels back via range + anchor (period start), so the dashboard
    // reopens on May 2026 instead of snapping to the most recent month.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('dashboard', { range: 'month', anchor: '2026-05-01' }),
    );
    localStorage.removeItem('fungible-keys');
  });

  it('search filters rows live', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('Search…'), 'Whole');
    await waitFor(() => expect(screen.getByText('2 transactions')).toBeTruthy());
  });

  it('clicking the Amount header sorts largest expense first', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByText(/^Amount/));
    await waitFor(() => {
      const rows = screen.getAllByRole('row').slice(1); // skip header
      expect(rows[0].textContent).toContain('Whole Foods');
      expect(rows[0].textContent).toContain('-$120.00');
    });
  });

  it('edit modal sets a manual category with override marker', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[0], 'Dining');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Transaction updated')).toBeTruthy());
    await waitFor(() => {
      const row = screen.getByText('Trader Joes').closest('tr')!;
      expect(row.textContent).toContain('◆');
      expect(row.textContent).toContain('Dining');
    });
  });

  it('edit modal reattributes a transaction date and preserves the posting date', async () => {
    const { container } = renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());

    const dateInput = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-05-14');
    fireEvent.change(dateInput, { target: { value: '2026-05-20' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Transaction updated')).toBeTruthy());
    await waitFor(() => {
      const row = screen.getByText('Trader Joes').closest('tr')!;
      expect(row.textContent).toContain('2026-05-20');
    });

    // First edit stashes the bank's posting date so it can always be restored.
    const res = await db.execute("SELECT date, original_date FROM transactions WHERE id = 'tx-groc-2'");
    expect(res.rows[0]).toMatchObject({ date: '2026-05-20', original_date: '2026-05-14' });
  });

  it('edit modal shows a reattributed-from note and restores the posting date', async () => {
    await db.execute(
      "UPDATE transactions SET date = '2026-05-20', original_date = '2026-05-14' WHERE id = 'tx-groc-2'",
    );
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText('Reattributed from 2026-05-14')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'restore posting date' }));
    await waitFor(() => expect(screen.getByText('Date restored to posting date')).toBeTruthy());

    const res = await db.execute("SELECT date, original_date FROM transactions WHERE id = 'tx-groc-2'");
    expect(res.rows[0]).toMatchObject({ date: '2026-05-14', original_date: null });
  });

  it('edit modal with a pattern shows live match count and saves a rule', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'Shopping');
    await userEvent.type(screen.getByPlaceholderText('optional — saves as rule'), 'Trader');
    await waitFor(() => expect(screen.getByText('1 transactions match')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Save as rule' }));
    await waitFor(() => expect(screen.getByText(/category rule \(\d+ updated\)/)).toBeTruthy());
  });

  it('ignore hover action marks a transaction ignored', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getAllByText('Sweetgreen').length).toBeGreaterThan(0));
    const row = screen.getAllByText('Sweetgreen')[0].closest('tr')!;
    const ignoreBtn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'ignore')!;
    await userEvent.click(ignoreBtn);
    await waitFor(() => {
      const updated = screen.getAllByText('Sweetgreen')[0].closest('tr')!;
      expect(updated.textContent).toContain('~');
    });
  });

  it('tag modal applies an existing tag to a transaction', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Con Edison')).toBeTruthy());
    const row = screen.getByText('Con Edison').closest('tr')!;
    const tagBtn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'tag')!;
    await userEvent.click(tagBtn);
    await waitFor(() => expect(screen.getByPlaceholderText('Filter or create…')).toBeTruthy());
    await userEvent.click(await screen.findByText('travel'));
    await waitFor(() => {
      const travelBtn = screen.getAllByRole('button').find((b) => b.textContent?.includes('travel'));
      expect(travelBtn?.textContent).toContain('●');
    });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      const updated = screen.getByText('Con Edison').closest('tr')!;
      expect(updated.textContent).toContain('travel');
    });
  });

  it('bulk categorize-all applies to every visible transaction', async () => {
    renderScreen(<Transactions />, { initialFilter: { categories: ['Grocery'] } });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categorize all' }));
    await waitFor(() => expect(screen.getByText(/Set category for 3/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Dining' }));
    await waitFor(() => expect(screen.getByText(/Set category to "Dining" for 3 transactions/)).toBeTruthy());
  });
});
