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

  // Search now lives in the shared FilterBar, not on Transactions itself —
  // filterBar:true mounts it here too, matching how App.tsx composes them.
  it('search filters rows live', async () => {
    renderScreen(<Transactions />, { filterBar: true });
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('Search transactions…'), 'Whole');
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

  it('edit modal sets a manual category with override marker, declining the rule offer', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[0], 'Dining');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    // A plain recategorize (no typed pattern) offers to turn it into a rule.
    await waitFor(() => expect(screen.getByText(/Always categorize/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'No, just this once' }));
    await waitFor(() => expect(screen.getByText('Transaction updated')).toBeTruthy());
    await waitFor(() => {
      const row = screen.getByText('Trader Joes').closest('tr')!;
      // The hairline reskin dropped the '◆' glyph in favor of the category
      // cell's existing manual/dim color styling alone (matched in the TUI
      // for the same reason — see tui/Transactions.tsx) — assert on the
      // still-present title attribute instead, which carries the same
      // "manually categorized" signal a glyph check used to.
      const catCell = row.querySelector('td[title="Manually categorized"]');
      expect(catCell).toBeTruthy();
      expect(row.textContent).toContain('Dining');
    });

    // Declining persists no rule.
    const rule = await db.execute("SELECT * FROM category_rules WHERE pattern = 'Trader Joes'");
    expect(rule.rows).toHaveLength(0);
  });

  it('edit modal offers a rule suggestion and creates a rule on accept', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Trader Joes')).toBeTruthy());
    await userEvent.click(screen.getByText('Trader Joes'));
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'Dining');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/Always categorize/)).toBeTruthy());
    expect(screen.getByText(/Always categorize/).textContent).toContain('Trader Joes');
    expect(screen.getByText(/1 other transaction/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Yes, make a rule' }));
    await waitFor(() => expect(screen.getByText(/rule created/)).toBeTruthy());

    const rule = await db.execute("SELECT * FROM category_rules WHERE pattern = 'Trader Joes'");
    expect(rule.rows[0]).toMatchObject({ match_type: 'name', category: 'Dining' });
  });

  it('edit modal offers to update a conflicting rule instead of creating a new one', async () => {
    await db.execute(
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Sweetgreen', 'Dining')",
    );
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getAllByText('Sweetgreen').length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByText('Sweetgreen')[0]);
    await waitFor(() => expect(screen.getByText(/^Edit/)).toBeTruthy());
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'Shopping');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText(/already has a rule/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Yes, update the rule' }));
    await waitFor(() => expect(screen.getByText(/rule updated/)).toBeTruthy());

    const rule = await db.execute("SELECT * FROM category_rules WHERE pattern = 'Sweetgreen'");
    expect(rule.rows).toHaveLength(1);
    expect(rule.rows[0]).toMatchObject({ category: 'Shopping' });
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
      // Row-level marker: a reattributed date shows a purple "*" next to it,
      // matching the TUI's C_MANUAL "*" suffix.
      const dateCell = row.querySelector('td:nth-child(2)')!;
      expect(dateCell.textContent).toContain('*');
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

  it('bulk categorize is disabled until a row is selected, then applies to the selection', async () => {
    renderScreen(<Transactions />, { initialFilter: { categories: ['Grocery'] } });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Categorize' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all visible' }));
    expect((screen.getByRole('button', { name: 'Categorize' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Categorize' }));
    await waitFor(() => expect(screen.getByText(/Set category for 3/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Dining' }));
    await waitFor(() => expect(screen.getByText(/Set category to "Dining" for 3 transactions/)).toBeTruthy());
  });

  it('the "+ Add" button opens the Add modal, and saving creates a whole-row-purple manual transaction', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(screen.getByText('Add transaction')).toBeTruthy());

    await userEvent.type(screen.getByPlaceholderText('e.g. Corner Store'), 'Cash Tip');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '12.50');
    const selects = screen.getAllByRole('combobox'); // [0] account, [1] category
    await userEvent.selectOptions(selects[1], 'Dining');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('Transaction added')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('10 transactions')).toBeTruthy());

    const row = screen.getByText('Cash Tip').closest('tr')!;
    expect(row.className).toContain('rowManual');
    expect(row.getAttribute('title')).toBe('Manually added — not from Plaid or a CSV import');
    // The category cell doesn't get its own purple — the whole row already carries it.
    const catCell = row.querySelector('td:nth-child(4)')!;
    expect(catCell.className).not.toContain('manual');

    const res = await db.execute("SELECT amount, source, category FROM transactions WHERE name = 'Cash Tip'");
    expect(res.rows[0]).toMatchObject({ amount: 12.5, source: 'manual', category: 'Dining' });
  });

  it('defaults to an expense and flips the sign when Income is picked', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(screen.getByText('Add transaction')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('e.g. Corner Store'), 'Refund');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Income' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText('Transaction added')).toBeTruthy());
    const res = await db.execute("SELECT amount FROM transactions WHERE name = 'Refund'");
    expect(res.rows[0]).toMatchObject({ amount: -20 });
  });

  it('requires a name before saving', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await waitFor(() => expect(screen.getByText('Add transaction')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('0.00'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText('Name is required')).toBeTruthy());
  });

  it('the "n" key opens the Add modal', async () => {
    localStorage.setItem('fungible-keys', 'on');
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.keyboard('n');
    await waitFor(() => expect(screen.getByText('Add transaction')).toBeTruthy());
    localStorage.removeItem('fungible-keys');
  });

  it('a manually-added transaction can be deleted, like a CSV row', async () => {
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored, source)
       VALUES ('tx-manual-1', 'test-checking', '2026-05-12', 'Cash Tip', 12.50, 'Dining', 0, 0, 'manual')`,
    );
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Cash Tip')).toBeTruthy());
    const row = screen.getByText('Cash Tip').closest('tr')!;
    const deleteBtn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'delete')!;
    await userEvent.click(deleteBtn);
    await waitFor(() => expect(screen.queryByText('Cash Tip')).toBeNull());
  });

  it('a manually-added row only offers tag + delete — no clear-override, no ignore/unignore', async () => {
    // addTransaction sets manual_category = category on insert (same
    // mechanism a normal recategorize uses), so a manual row is also
    // "isPinned" — but there's no Plaid/CSV raw_category for it to revert
    // to, so the clear-override action must stay hidden for it regardless.
    // Ignoring is hidden too: hand-typed rows that shouldn't count belong
    // deleted outright, not hidden from totals while still sitting in the DB.
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, pending, ignored, source)
       VALUES ('tx-manual-2', 'test-checking', '2026-05-12', 'Cash Tip', 12.50, 'Dining', 'Dining', 0, 0, 'manual')`,
    );
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('Cash Tip')).toBeTruthy());
    const row = screen.getByText('Cash Tip').closest('tr')!;
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['tag', 'delete']);
  });
});
