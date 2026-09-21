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
import { Tags } from '../../gui/renderer/src/screens/Tags.js';

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

describe('GUI Tags', () => {
  it('lists seeded tags', async () => {
    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('travel')).toBeTruthy());
    expect(screen.getByText('work')).toBeTruthy();
  });

  it('filter narrows the list', async () => {
    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('travel')).toBeTruthy());
    await userEvent.type(screen.getByPlaceholderText('Filter tags…'), 'tra');
    await waitFor(() => expect(screen.queryByText('work')).toBeNull());
    expect(screen.getByText('travel')).toBeTruthy();
  });

  it('creates a tag via the modal', async () => {
    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('travel')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: '+ New tag' }));
    await userEvent.type(screen.getByPlaceholderText('Tag name'), 'vacation');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('vacation')).toBeTruthy());
  });

  // Rename/delete now live in the detail panel (act on the selected tag),
  // not as per-row list buttons — select the tag first to reach them.
  it('renames a tag via the detail panel', async () => {
    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('work')).toBeTruthy());
    await userEvent.click(screen.getByText('work'));
    await waitFor(() => expect(screen.getByText('# work')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'rename' }));
    const input = screen.getByPlaceholderText('Tag name');
    await userEvent.clear(input);
    await userEvent.type(input, 'office');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('office')).toBeTruthy());
    expect(screen.queryByText('work')).toBeNull();
    // Detail panel follows the rename rather than losing its selection.
    expect(screen.getByText('# office')).toBeTruthy();
  });

  it('deletes a tag via the detail panel', async () => {
    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('work')).toBeTruthy());
    await userEvent.click(screen.getByText('work'));
    await waitFor(() => expect(screen.getByText('# work')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(screen.queryByText('work')).toBeNull());
    expect(screen.getByText('Deleted "work"')).toBeTruthy();
    // Selection clears along with the deleted tag.
    expect(screen.getByText('Select a tag to see its breakdown.')).toBeTruthy();
  });

  it('detail panel shows breakdown and navigates to transactions', async () => {
    // tag a transaction so the detail has data
    await db.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-groc-1', 1)`);
    const navigate = vi.fn();
    renderScreen(<Tags />, { navigate });
    await waitFor(() => expect(screen.getByText('travel')).toBeTruthy());
    await userEvent.click(screen.getByText('travel'));
    await waitFor(() => expect(screen.getByText('# travel')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Grocery')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'all transactions →' }));
    // Drill-ins write the tag into the shared filter; nav only carries drillFrom.
    expect(navigate).toHaveBeenCalledWith('transactions', { drillFrom: 'tags' });
  });

  it('opens detail directly from a tag nav filter', async () => {
    renderScreen(<Tags />, { txFilter: { focusTag: 'travel' } });
    await waitFor(() => expect(screen.getByText('# travel')).toBeTruthy());
  });

  it('headline Inflow/Outflow are gross (not netted by category like the breakdown below)', async () => {
    // A $300 spend + a $100 refund in the same real category (Travel) nets to
    // $200 in getTagSummary's byCategory bucket (correct for that section) —
    // but the headline KPIs must show the true gross $100 inflow / $300
    // outflow (selected.inflow/outflow from getAllTags), not summary's netted
    // income/expenses, or a reimbursement silently vanishes into Outflow.
    await db.batch([
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel-spend',  'test-credit', '2026-05-04', 'Amtrak',        300.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel-refund', 'test-credit', '2026-05-05', 'Amtrak Refund', -100.00, 'Travel', 0, 0)`,
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-travel-spend', 1)`,
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-travel-refund', 1)`,
    ], 'write');

    renderScreen(<Tags />);
    await waitFor(() => expect(screen.getByText('travel')).toBeTruthy());
    await userEvent.click(screen.getByText('travel'));
    await waitFor(() => expect(screen.getByText('# travel')).toBeTruthy());

    // Headline: gross, unnetted.
    await waitFor(() => expect(screen.getByText('$100.00')).toBeTruthy()); // Inflow
    expect(screen.getByText('$300.00')).toBeTruthy(); // Outflow
    // Net (income - expenses) is the same either way: spent $300, got $100
    // back, net cash flow is -$200 whether or not the category nets first.
    expect(screen.getByText('-$200.00')).toBeTruthy();
    // The category breakdown below still nets, on purpose.
    await waitFor(() => expect(screen.getByText('Travel')).toBeTruthy());
    const categoryRow = screen.getByText('Travel').closest('tr')!;
    expect(categoryRow.textContent).toContain('$200.00');
  });
});
