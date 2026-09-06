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
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
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
