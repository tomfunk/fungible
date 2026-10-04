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
import { readTx, readTxTags } from '../helpers/readDb.js';
import { installBridge, renderScreen, saveCsvStub } from './helpers/renderGui.js';
import { Transactions } from '../../gui/renderer/src/screens/Transactions.js';
import { registry } from '../../gui/main/registry.js';

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
  saveCsvStub.calls = [];
  saveCsvStub.result = true;
});

afterEach(() => {
  cleanup();
  // Tests turn the keyboard shortcuts on; clearing here (not at the end of a
  // test body) means a failing test cannot leak the setting into the next one.
  localStorage.removeItem('fungible-keys');
  saveCsvStub.calls = [];
  saveCsvStub.result = true;
});

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
    const ignored = await db.execute("SELECT id, ignored FROM transactions WHERE name = 'Sweetgreen' ORDER BY date DESC");
    expect(ignored.rows.map((r) => Number(r.ignored))).toEqual([1, 0]); // only the clicked (May) row
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
    // The outcome is in the DB, on all three selected rows (manual_category is the pin).
    for (const id of ['tx-groc-1', 'tx-groc-2', 'tx-groc-apr']) {
      const r = (await readTx(db, id))!;
      expect(r.category).toBe('Dining');
      expect(r.manual_category).toBe('Dining');
    }
    // Rows outside the selection are untouched.
    expect((await readTx(db, 'tx-shopping'))!.manual_category).toBeNull();

    // Outcome in the DB: exactly the 3 Grocery rows moved and are pinned; nothing else changed.
    const res = await db.execute('SELECT id, category, manual_category FROM transactions ORDER BY id');
    const byId = Object.fromEntries(res.rows.map((r) => [r.id as string, r]));
    for (const id of ['tx-groc-1', 'tx-groc-2', 'tx-groc-apr']) {
      expect(byId[id]).toMatchObject({ category: 'Dining', manual_category: 'Dining' });
    }
    expect(byId['tx-dining-1']).toMatchObject({ category: 'Dining', manual_category: null });
    expect(byId['tx-bills-1']).toMatchObject({ category: 'Bills & Utilities', manual_category: null });
    expect(byId['tx-shopping']).toMatchObject({ category: 'Shopping', manual_category: null });
    expect(byId['tx-income']).toMatchObject({ category: 'Income', manual_category: null });
  });

  it('bulk categorize with one of three rows selected changes only that row', async () => {
    renderScreen(<Transactions />, { initialFilter: { categories: ['Grocery'] } });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    const row = screen.getByText('Trader Joes').closest('tr')!;
    await userEvent.click(row.querySelector('input[type="checkbox"]')!);
    await userEvent.click(screen.getByRole('button', { name: 'Categorize' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Dining' }));
    await waitFor(() => expect(screen.getByText(/Set category to "Dining" for 1 transaction/)).toBeTruthy());

    const res = await db.execute("SELECT id, category, manual_category FROM transactions WHERE id LIKE 'tx-groc%' ORDER BY id");
    expect(res.rows.map((r) => [r.id, r.category, r.manual_category])).toEqual([
      ['tx-groc-1', 'Grocery', null],
      ['tx-groc-2', 'Dining', 'Dining'],
      ['tx-groc-apr', 'Grocery', null],
    ]);
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

  it('Export passes the shared filter + date range through to core/export.ts and saves the result', async () => {
    const spy = vi.spyOn(registry.transactions, 'exportTransactionsCsv');
    renderScreen(<Transactions />, {
      txFilter: { from: '2026-05-01', to: '2026-05-31' },
      initialFilter: { categories: ['Grocery'] },
    });
    await waitFor(() => expect(screen.getByText('2 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText('Exported transactions')).toBeTruthy());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { categories: ['Grocery'] }, from: '2026-05-01', to: '2026-05-31' }),
    );
  });

  it('Export writes the filtered rows to a CSV named for the range, with signs and quoting', async () => {
    // A merchant name with a comma and quotes must be RFC 4180 quoted.
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-groc-q', 'test-credit', '2026-05-20', 'Joe''s, "Best" Market', 10.00, 'Grocery', 0, 0)`,
    );
    renderScreen(<Transactions />, {
      txFilter: { from: '2026-05-01', to: '2026-05-31' },
      initialFilter: { categories: ['Grocery'] },
    });
    await waitFor(() => expect(screen.getByText('3 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText('Exported transactions')).toBeTruthy());

    expect(saveCsvStub.calls).toHaveLength(1);
    const { csv, name } = saveCsvStub.calls[0];
    expect(name).toBe('transactions-2026-05-01-to-2026-05-31.csv');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,name,display_name,amount,category,account,tags,is_ignored,is_pending');
    // Ordered by date; stored outflow (positive) is exported negative.
    expect(lines.slice(1)).toEqual([
      '2026-05-06,Whole Foods,Whole Foods,-120.00,Grocery,Test Visa,,false,false',
      '2026-05-14,Trader Joes,Trader Joes,-85.00,Grocery,Test Visa,,false,false',
      '2026-05-20,"Joe\'s, ""Best"" Market","Joe\'s, ""Best"" Market",-10.00,Grocery,Test Visa,,false,false',
    ]);
    expect(csv).not.toContain('Sweetgreen');
    expect(csv).not.toContain('2026-04');
  });

  it('Export exports inflows as positive amounts', async () => {
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText('Exported transactions')).toBeTruthy());
    expect(saveCsvStub.calls[0].csv).toContain('2026-05-01,Direct Deposit,Direct Deposit,3500.00,Income,Test Checking,,false,false');
  });

  it('Export shows no success toast when the save dialog is cancelled', async () => {
    saveCsvStub.result = false;
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saveCsvStub.calls).toHaveLength(1));
    // Export button re-enables once the attempt settles.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Exported transactions')).toBeNull();
  });

  it('Export surfaces a failure as a toast', async () => {
    saveCsvStub.result = new Error('EACCES: permission denied');
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText('EACCES: permission denied')).toBeTruthy());
    expect(screen.queryByText('Exported transactions')).toBeNull();
  });

  it('Export falls back to the full data span when no date range is picked', async () => {
    const spy = vi.spyOn(registry.transactions, 'exportTransactionsCsv');
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText('Exported transactions')).toBeTruthy());
    const call = spy.mock.calls[0][0];
    expect(call.from).toBeTruthy();
    expect(call.to).toBeTruthy();
  });

  it('shows a caveat when a txType/flex filter is active, since export does not support those dimensions', async () => {
    // Freeze the export mid-flight so the caveat toast (fired before the
    // export call) can't be overwritten by the success toast before this
    // test observes it — mirrors the TUI's export-modal caveat test
    // (tests/tui/screens.test.tsx), which checks the same static text.
    const spy = vi.spyOn(registry.transactions, 'exportTransactionsCsv').mockImplementation(() => new Promise(() => {}));
    renderScreen(<Transactions />, { txFilter: { txType: 'expenses' } });
    await waitFor(() => expect(screen.getByText('7 transactions')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText(/isn't applied to the exported file/)).toBeTruthy());
    spy.mockRestore();
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

// ── Bulk actions (Clear overrides / Ignore / Tag) and single-row clear ──────
// Every assertion reads the DB: the toasts and glyphs are only the echo.
describe('GUI Transactions: bulk actions', () => {
  const rowOf = (name: string) => screen.getAllByText(name)[0].closest('tr')!;
  const check = (name: string) => userEvent.click(rowOf(name).querySelector('input[type="checkbox"]')!);
  const bulkBtn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const BULK = ['Categorize', 'Tag', 'Clear overrides', 'Ignore'];

  async function pin(id: string, cat: string) {
    await db.execute({ sql: 'UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?', args: [cat, cat, id] });
  }

  it('all four bulk buttons are disabled with no selection, and selection clears after an action', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    for (const b of BULK) expect(bulkBtn(b).disabled).toBe(true);
    expect(screen.getByText('9 visible')).toBeTruthy();

    await check('Amazon');
    await check('Con Edison');
    expect(screen.getByText('2 selected')).toBeTruthy();
    for (const b of BULK) expect(bulkBtn(b).disabled).toBe(false);

    await userEvent.click(bulkBtn('Ignore'));
    await waitFor(() => expect(screen.getByText('Ignored 2 transactions')).toBeTruthy());
    // selection cleared: count text reverts and buttons disable again
    await waitFor(() => expect(screen.getByText('9 visible')).toBeTruthy());
    for (const b of BULK) expect(bulkBtn(b).disabled).toBe(true);
    expect((rowOf('Amazon').querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });

  it('Clear overrides un-pins the selected rows (back to the rule result) and leaves unselected pins alone', async () => {
    await pin('tx-groc-1', 'Dining'); // Whole Foods: the 'Whole Foods' rule maps it to Grocery
    await pin('tx-shopping', 'Dining'); // Amazon, unselected
    await pin('tx-bills-1', 'Dining'); // Con Edison, selected
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());

    await check('Whole Foods');
    await check('Con Edison');
    await userEvent.click(bulkBtn('Clear overrides'));
    await waitFor(() => expect(screen.getByText('Cleared overrides on 2 transactions')).toBeTruthy());

    const wf = (await readTx(db, 'tx-groc-1'))!;
    expect(wf.manual_category).toBeNull();
    expect(wf.category).toBe('Grocery'); // recomputed from the rule, not left as 'Dining'
    const ce = (await readTx(db, 'tx-bills-1'))!;
    expect(ce.manual_category).toBeNull();
    expect(ce.category).not.toBe('Dining');
    const amazon = (await readTx(db, 'tx-shopping'))!;
    expect(amazon.manual_category).toBe('Dining');
    expect(amazon.category).toBe('Dining');
  });

  it('Clear overrides counts only the rows that actually carried an override', async () => {
    await pin('tx-bills-1', 'Dining');
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await check('Con Edison');
    await check('Amazon'); // not pinned
    await userEvent.click(bulkBtn('Clear overrides'));
    await waitFor(() => expect(screen.getByText('Cleared overrides on 1 transaction')).toBeTruthy());
    expect((await readTx(db, 'tx-shopping'))!.category).toBe('Shopping');
  });

  it('bulk Ignore sets ignored=1 on both rows; selecting them again offers Un-ignore, which clears them', async () => {
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await check('Amazon');
    await check('Con Edison');
    await userEvent.click(bulkBtn('Ignore'));
    await waitFor(() => expect(screen.getByText('Ignored 2 transactions')).toBeTruthy());
    expect((await readTx(db, 'tx-shopping'))!.ignored).toBe(1);
    expect((await readTx(db, 'tx-bills-1'))!.ignored).toBe(1);
    expect((await readTx(db, 'tx-groc-1'))!.ignored).toBe(0);

    await waitFor(() => expect(rowOf('Amazon').textContent).toContain('~'));
    await check('Amazon');
    await check('Con Edison');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Un-ignore' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Un-ignore' }));
    await waitFor(() => expect(screen.getByText('Un-ignored 2 transactions')).toBeTruthy());
    expect((await readTx(db, 'tx-shopping'))!.ignored).toBe(0);
    expect((await readTx(db, 'tx-bills-1'))!.ignored).toBe(0);
  });

  it('bulk Ignore of a single row uses the singular status', async () => {
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await check('Amazon');
    await userEvent.click(bulkBtn('Ignore'));
    await waitFor(() => expect(screen.getByText('Ignored 1 transaction')).toBeTruthy());
  });

  it('bulk Tag applies an existing tag to every selected row and no others', async () => {
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await check('Amazon');
    await check('Con Edison');
    await userEvent.click(bulkBtn('Tag'));
    await waitFor(() => expect(screen.getByText('Tag 2 visible transactions')).toBeTruthy());
    await userEvent.click(await screen.findByRole('button', { name: 'work' }));
    await waitFor(() => expect(screen.getByText('Tagged 2 transactions')).toBeTruthy());
    expect(await readTxTags(db, 'tx-shopping')).toEqual(['work']);
    expect(await readTxTags(db, 'tx-bills-1')).toEqual(['work']);
    expect(await readTxTags(db, 'tx-groc-1')).toEqual([]);
  });

  it('single-row clear resets a pinned row; a non-pinned row has no clear button', async () => {
    await pin('tx-shopping', 'Dining');
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    const labels = (name: string) => Array.from(rowOf(name).querySelectorAll('button')).map((b) => b.textContent);
    expect(labels('Con Edison')).not.toContain('clear');
    expect(labels('Amazon')).toContain('clear');

    await userEvent.click(Array.from(rowOf('Amazon').querySelectorAll('button')).find((b) => b.textContent === 'clear')!);
    await waitFor(() => expect(screen.getByText('Override cleared')).toBeTruthy());
    const r = (await readTx(db, 'tx-shopping'))!;
    expect(r.manual_category).toBeNull();
    expect(r.category).not.toBe('Dining');
  });

  // PRODUCT BUG: the bulk actions bypass the guards the single-row UI applies to
  // source='manual' rows. A hand-entered row is also "pinned" (addTransaction
  // sets manual_category = category) with no raw category to revert to, so the
  // single-row UI hides both clear and ignore for it. Bulk Clear overrides
  // (core clearOverridesBulk selects every manual_category IS NOT NULL row) wipes
  // the manual row's category; bulk Ignore ignores it. Fix: exclude
  // source = 'manual' ids in clearOverridesBulk/setIgnoredBulk (or filter them
  // out of selectedTxs in Transactions.tsx), then flip these to plain `it`.
  it.fails('BUG: bulk Clear overrides keeps a manual-source row\'s category', async () => {
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, pending, ignored, source)
       VALUES ('tx-manual-3', 'test-checking', '2026-05-12', 'Cash Tip', 12.50, 'Dining', 'Dining', 0, 0, 'manual')`,
    );
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('Cash Tip')).toBeTruthy());
    await check('Cash Tip');
    await userEvent.click(bulkBtn('Clear overrides'));
    await waitFor(() => expect(screen.getByText(/Cleared overrides on/)).toBeTruthy());
    const r = (await readTx(db, 'tx-manual-3'))!;
    expect(r.category).toBe('Dining');
    expect(r.manual_category).toBe('Dining');
  });

  it.fails('BUG: bulk Ignore does not ignore a manual-source row (single-row UI forbids it)', async () => {
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, pending, ignored, source)
       VALUES ('tx-manual-4', 'test-checking', '2026-05-12', 'Cash Tip', 12.50, 'Dining', 'Dining', 0, 0, 'manual')`,
    );
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('Cash Tip')).toBeTruthy());
    await check('Cash Tip');
    await userEvent.click(bulkBtn('Ignore'));
    await waitFor(() => expect(screen.getByText(/Ignored 1 transaction/)).toBeTruthy());
    expect((await readTx(db, 'tx-manual-4'))!.ignored).toBe(0);
  });

  // Not a defect, a documented rule: a mixed selection takes its bulk-Ignore
  // direction from the first selected row in TABLE order (target = !selectedTxs[0]
  // .ignored), and the button label shows that direction before you click. The
  // status count is the selection size, not the number of rows that changed.
  it('bulk Ignore on a mixed selection follows the first row in table order, and the label matches the outcome (status count = selection size, not rows changed)', async () => {
    await db.execute("UPDATE transactions SET ignored = 1 WHERE id = 'tx-shopping'"); // Amazon 05-11, first in date-desc order
    renderScreen(<Transactions />, { txFilter: { from: '2026-05-01', to: '2026-05-31' } });
    await waitFor(() => expect(screen.getByText('6 transactions')).toBeTruthy());
    await check('Con Edison'); // click order does not matter...
    await check('Amazon');
    expect(bulkBtn('Un-ignore')).toBeTruthy(); // ...the label follows the first row in the table (ignored Amazon)
    await userEvent.click(bulkBtn('Un-ignore'));
    await waitFor(() => expect(screen.getByText('Un-ignored 2 transactions')).toBeTruthy());
    expect((await readTx(db, 'tx-shopping'))!.ignored).toBe(0);
    expect((await readTx(db, 'tx-bills-1'))!.ignored).toBe(0); // was never ignored; stays so
  });
});
