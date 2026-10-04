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
import { Rules } from '../../gui/renderer/src/screens/Rules.js';

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'tag_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

/** Row count in a table, so a test can prove both underlying records changed. */
async function tableCount(table: string): Promise<number> {
  const res = await db.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number((res.rows[0] as unknown as { c: number }).c);
}

/** A name rule whose match (type/pattern/account/amounts) equals the seeded
 *  'Whole Foods' category rule, so the two merge into one row. */
async function seedPairedNameRule() {
  await db.execute(
    `INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount, account_id)
     VALUES ('name', 'Whole Foods', 'WF Market', NULL, NULL, NULL)`,
  );
}

describe('GUI Rules', () => {
  it('lists the seeded category rule', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Rules (1)' })).toBeTruthy();
    expect(screen.getByText('Grocery')).toBeTruthy();
  });

  it('shows a category rule and its matching name rule as one row', async () => {
    await seedPairedNameRule();
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    // Two records, one row.
    expect(screen.getByRole('button', { name: 'Rules (1)' })).toBeTruthy();
    const row = screen.getByText('Whole Foods').closest('tr')!;
    expect(row.textContent).toContain('Grocery');
    expect(row.textContent).toContain('WF Market');
  });

  it('creates a category rule with live match count and recategorizes', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await userEvent.type(screen.getByPlaceholderText('e.g. UBER or ^AMZN'), 'Trader');
    await waitFor(() => expect(screen.getByText('1 transactions match')).toBeTruthy());
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[1], 'Dining'); // [0] = match type, [1] = category
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/recategorized \d+ transactions?/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Rules (2)' })).toBeTruthy();
    expect(await tableCount('name_rules')).toBe(0);
  });

  it('creates a category rule and a name rule in one save', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await userEvent.type(screen.getByPlaceholderText('e.g. UBER or ^AMZN'), 'Trader');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], 'Dining');
    await userEvent.type(screen.getByPlaceholderText('e.g. Amazon'), 'TJs');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Rule saved/)).toBeTruthy());
    expect(await tableCount('category_rules')).toBe(2);
    expect(await tableCount('name_rules')).toBe(1);
    // Both records land on one row.
    expect(screen.getByRole('button', { name: 'Rules (2)' })).toBeTruthy();
    const row = screen.getByText('Trader').closest('tr')!;
    expect(row.textContent).toContain('Dining');
    expect(row.textContent).toContain('TJs');
  });

  it('creates a name-only rule when the category is "— none —"', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await userEvent.type(screen.getByPlaceholderText('e.g. UBER or ^AMZN'), 'AMZN');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], '');
    await userEvent.type(screen.getByPlaceholderText('e.g. Amazon'), 'Amazon');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Rule saved/)).toBeTruthy());
    expect(await tableCount('name_rules')).toBe(1);
    expect(await tableCount('category_rules')).toBe(1); // only the seeded one
    expect(screen.getByRole('button', { name: 'Rules (2)' })).toBeTruthy();
    const row = screen.getByText('AMZN').closest('tr')!;
    expect(row.textContent).toContain('Amazon');
  });

  it('starts a new rule with no category, so a rename-only rule cannot categorize by accident', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    const categorySelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect(categorySelect.value).toBe('');
    expect(screen.getByRole('option', { name: '— none —' })).toBeTruthy();
  });

  it('disables Save until a category or a display name is set, and says why', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // no pattern yet
    // Nothing typed yet: the form isn't asking for anything, so stay quiet.
    expect(screen.queryByText('Pick a category or enter a display name to save.')).toBeNull();

    await userEvent.type(screen.getByPlaceholderText('e.g. UBER or ^AMZN'), 'AMZN');
    expect(save.disabled).toBe(true); // a rule that neither categorizes nor renames
    expect(screen.getByText('Pick a category or enter a display name to save.')).toBeTruthy();

    await userEvent.type(screen.getByPlaceholderText('e.g. Amazon'), 'Amazon');
    expect(save.disabled).toBe(false);
    expect(screen.queryByText('Pick a category or enter a display name to save.')).toBeNull();
  });

  it('hides the hint once a category alone is picked', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await userEvent.type(screen.getByPlaceholderText('e.g. UBER or ^AMZN'), 'AMZN');
    expect(screen.getByText('Pick a category or enter a display name to save.')).toBeTruthy();
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], 'Shopping');
    expect(screen.queryByText('Pick a category or enter a display name to save.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('spells out that "none" removes an existing category rule', async () => {
    await seedPairedNameRule();
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByText('Whole Foods'));
    expect(screen.getByRole('option', { name: '— none (removes rule) —' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '— none —' })).toBeNull();
  });

  it('keeps the plain "none" label on a row with no category rule', async () => {
    await db.execute(
      `INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount, account_id)
       VALUES ('name', 'AMZN', 'Amazon', NULL, NULL, NULL)`,
    );
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('AMZN')).toBeTruthy());
    await userEvent.click(screen.getByText('AMZN'));
    expect(screen.getByRole('option', { name: '— none —' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '— none (removes rule) —' })).toBeNull();
  });

  it('removes the category rule when an edited row is set to "none"', async () => {
    await seedPairedNameRule();
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByText('Whole Foods'));
    await userEvent.selectOptions(screen.getAllByRole('combobox')[1], '');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Rule saved/)).toBeTruthy());
    expect(await tableCount('category_rules')).toBe(0);
    expect(await tableCount('name_rules')).toBe(1);
  });

  it('deletes a rule', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    const row = screen.getByText('Whole Foods').closest('tr')!;
    await userEvent.click(Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'delete')!);
    await waitFor(() => expect(screen.getByText(/Rule deleted · recategorized \d+ transactions?/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Rules (0)' })).toBeTruthy();
  });

  it('deleting a merged row removes both underlying records', async () => {
    await seedPairedNameRule();
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    const row = screen.getByText('Whole Foods').closest('tr')!;
    await userEvent.click(Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'delete')!);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rules (0)' })).toBeTruthy());
    expect(await tableCount('category_rules')).toBe(0);
    expect(await tableCount('name_rules')).toBe(0);
  });

  it('drops the name rule when the display name is cleared on an existing row', async () => {
    await seedPairedNameRule();
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('WF Market')).toBeTruthy());
    await userEvent.click(screen.getByText('Whole Foods'));
    const displayName = screen.getByPlaceholderText('e.g. Amazon');
    await userEvent.clear(displayName);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Rule saved/)).toBeTruthy());
    expect(await tableCount('name_rules')).toBe(0);
    expect(await tableCount('category_rules')).toBe(1);
  });

  it('categories tab lists categories with flexibility and visibility controls', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    expect(screen.getByText('Dining')).toBeTruthy();
    // Grocery's inline flexibility select shows 'flexible'
    const grocerySelect = screen.getByText('Grocery').closest('tr')!.querySelector('select') as HTMLSelectElement;
    expect(grocerySelect.value).toBe('flexible');
    // toggle visibility
    const visibleBtn = Array.from(screen.getByText('Grocery').closest('tr')!.querySelectorAll('button'))
      .find((b) => b.textContent === 'visible')!;
    await userEvent.click(visibleBtn);
    await waitFor(() => {
      const row = screen.getByText('Grocery').closest('tr')!;
      expect(Array.from(row.querySelectorAll('button')).some((b) => b.textContent === 'hidden')).toBe(true);
    });
    // Persisted: Grocery (and only Grocery) is now in hidden_categories.
    const hidden = await db.execute('SELECT category FROM hidden_categories');
    expect(hidden.rows.map((r) => r.category)).toEqual(['Grocery']);

    // Toggling again un-hides it.
    await userEvent.click(
      Array.from(screen.getByText('Grocery').closest('tr')!.querySelectorAll('button')).find((b) => b.textContent === 'hidden')!,
    );
    await waitFor(async () => {
      expect((await db.execute('SELECT category FROM hidden_categories')).rows).toHaveLength(0);
    });
  });

  it('changes a category flexibility inline', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await waitFor(() => expect(screen.getByText('Shopping')).toBeTruthy());
    const select = screen.getByText('Shopping').closest('tr')!.querySelector('select') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'fixed');
    await waitFor(() => {
      const after = screen.getByText('Shopping').closest('tr')!.querySelector('select') as HTMLSelectElement;
      expect(after.value).toBe('fixed');
    });
    const res = await db.execute('SELECT name, flexibility FROM categories ORDER BY name');
    expect(Object.fromEntries(res.rows.map((r) => [r.name, r.flexibility]))).toEqual({
      'Bills & Utilities': 'fixed',
      Dining: 'discretionary',
      Grocery: 'flexible',
      Income: null,
      Shopping: 'fixed', // changed
    });
  });

  it('clearing a category flexibility to "—" stores NULL', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await waitFor(() => expect(screen.getByText('Dining')).toBeTruthy());
    const select = screen.getByText('Dining').closest('tr')!.querySelector('select') as HTMLSelectElement;
    await userEvent.selectOptions(select, '');
    await waitFor(async () => {
      const res = await db.execute("SELECT flexibility FROM categories WHERE name = 'Dining'");
      expect(res.rows[0].flexibility).toBeNull();
    });
  });

  it('creates a category via the Add modal', async () => {
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add' }));
    await userEvent.type(screen.getByPlaceholderText('Category name'), '  Pets  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Created "Pets"')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Categories (6)' })).toBeTruthy();
    const res = await db.execute("SELECT name, flexibility FROM categories WHERE name LIKE '%Pets%'");
    expect(res.rows.map((r) => ({ ...r }))).toEqual([{ name: 'Pets', flexibility: null }]);
  });

  it('renames a category: transactions, the rule and flexibility follow it', async () => {
    await db.execute("UPDATE transactions SET manual_category = 'Grocery' WHERE id = 'tx-groc-1'");
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(
      Array.from(screen.getByText('Grocery').closest('tr')!.querySelectorAll('button')).find((b) => b.textContent === 'rename')!,
    );
    const input = screen.getByPlaceholderText('Category name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Food');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Category renamed')).toBeTruthy());

    const tx = await db.execute("SELECT id, category FROM transactions WHERE id LIKE 'tx-groc%' ORDER BY id");
    expect(tx.rows.map((r) => r.category)).toEqual(['Food', 'Food', 'Food']);
    // The pinned (manual) category follows the rename too.
    const pinned = await db.execute("SELECT manual_category FROM transactions WHERE id = 'tx-groc-1'");
    expect(pinned.rows[0].manual_category).toBe('Food');
    const cats = await db.execute('SELECT name, flexibility FROM categories WHERE name IN (\'Grocery\', \'Food\')');
    expect(cats.rows.map((r) => ({ ...r }))).toEqual([{ name: 'Food', flexibility: 'flexible' }]);
    const rule = await db.execute('SELECT category FROM category_rules');
    expect(rule.rows.map((r) => r.category)).toEqual(['Food']);
    // Other categories untouched.
    const other = await db.execute("SELECT category FROM transactions WHERE id = 'tx-dining-1'");
    expect(other.rows[0].category).toBe('Dining');
  });

  it('deleting a category resets its transactions to Uncategorized and drops it', async () => {
    await db.execute("INSERT INTO hidden_categories (category) VALUES ('Dining')");
    await db.execute("UPDATE transactions SET manual_category = 'Dining' WHERE id = 'tx-dining-1'");
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('Whole Foods')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Categories (5)' }));
    await waitFor(() => expect(screen.getByText('Dining')).toBeTruthy());
    await userEvent.click(
      Array.from(screen.getByText('Dining').closest('tr')!.querySelectorAll('button')).find((b) => b.textContent === 'delete')!,
    );
    await waitFor(() => expect(screen.getByText(/Deleted "Dining"/)).toBeTruthy());

    const tx = await db.execute("SELECT id, category, manual_category FROM transactions WHERE id LIKE 'tx-dining%' ORDER BY id");
    expect(tx.rows.map((r) => [r.id, r.category, r.manual_category])).toEqual([
      ['tx-dining-1', 'Uncategorized', null],
      ['tx-dining-apr', 'Uncategorized', null],
    ]);
    expect((await db.execute("SELECT 1 FROM categories WHERE name = 'Dining'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM hidden_categories WHERE category = 'Dining'")).rows).toHaveLength(0);
    // Unrelated categories keep their rows.
    expect((await db.execute("SELECT category FROM transactions WHERE id = 'tx-shopping'")).rows[0].category).toBe('Shopping');
  });

  it('shows uncategorized count when present', async () => {
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-unc', 'test-credit', '2026-05-20', 'Mystery Shop', 10.00, 'Uncategorized', 0, 0)`,
    );
    renderScreen(<Rules />);
    await waitFor(() => expect(screen.getByText('1 uncategorized')).toBeTruthy());
  });
});
