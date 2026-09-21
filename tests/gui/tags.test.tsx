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
});
