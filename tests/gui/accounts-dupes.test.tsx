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
import { seedTx } from '../helpers/seedDb.js';
import { readTx, readTxTags, countRows } from '../helpers/readDb.js';
import { registry } from '../../gui/main/registry.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

const ACCT = 'test-checking';

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  // seedTuiData's own transactions never pair with each other (different
  // accounts/amounts, all source defaults), so the Dupes tab starts empty.
  installBridge();
});

afterEach(() => cleanup());

/** A CSV row plus its Plaid twin, one day apart, same amount and name. */
async function seedPair(n: number, over: { csv?: Parameters<typeof seedTx>[1]; plaid?: Parameters<typeof seedTx>[1] } = {}) {
  const csv = await seedTx(db, {
    id: `csv-${n}`, account_id: ACCT, source: 'csv', date: `2026-03-0${n}`, name: `Cafe ${n}`, amount: 12.5 + n,
    ...over.csv,
  });
  const plaid = await seedTx(db, {
    id: `plaid-${n}`, account_id: ACCT, source: 'plaid', date: `2026-03-0${n + 1}`, name: `Cafe ${n}`, amount: 12.5 + n,
    ...over.plaid,
  });
  return { csv, plaid };
}

async function openDupes() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: /^Dupes/ }));
}

describe('GUI Accounts: Dupes tab', () => {
  it('shows a count in the tab label, singular bar text and both rows of the pair', async () => {
    await seedPair(1);
    renderScreen(<Accounts />);
    const tab = await screen.findByRole('button', { name: 'Dupes (1)' });
    await userEvent.click(tab);
    expect(screen.getByText('1 CSV transaction that look like Plaid duplicates')).toBeTruthy();
    // CSV row + Plaid row both render, same name
    expect(screen.getAllByText('Cafe 1')).toHaveLength(2);
    expect(screen.getByText('2026-03-01')).toBeTruthy();
    expect(screen.getByText('2026-03-02')).toBeTruthy();
    expect(screen.getByText('$13.50')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'delete CSV copy' })).toBeTruthy();
  });

  it('uses the plural bar text for two pairs', async () => {
    await seedPair(1);
    await seedPair(2);
    await openDupes();
    expect(await screen.findByText('2 CSV transactions that look like Plaid duplicates')).toBeTruthy();
  });

  it('shows the empty state and no count when nothing pairs', async () => {
    await openDupes();
    expect(screen.getByRole('button', { name: 'Dupes' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dupes' }));
    expect(screen.getByText('No duplicate candidates found.')).toBeTruthy();
  });

  it('delete CSV copy removes the CSV row, keeps the Plaid row, and shows the status', async () => {
    await seedPair(1);
    await openDupes();
    await userEvent.click(await screen.findByRole('button', { name: 'delete CSV copy' }));
    await waitFor(() => expect(screen.getByText('CSV copy deleted')).toBeTruthy());
    expect(await readTx(db, 'csv-1')).toBeNull();
    expect((await readTx(db, 'plaid-1'))?.source).toBe('plaid');
    await waitFor(() => expect(screen.getByText('No duplicate candidates found.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Dupes' })).toBeTruthy();
  });

  it('transfers category, display name, ignored flag and tags onto the surviving Plaid row', async () => {
    await seedPair(1, { csv: { manual_category: 'Dining', display_name: 'My Cafe', ignored: true } });
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-1', 1)");
    await openDupes();
    await userEvent.click(await screen.findByRole('button', { name: 'delete CSV copy' }));
    await waitFor(() => expect(screen.getByText('CSV copy deleted')).toBeTruthy());

    expect(await readTx(db, 'csv-1')).toBeNull();
    const plaid = (await readTx(db, 'plaid-1'))!;
    expect(plaid.manual_category).toBe('Dining');
    expect(plaid.category).toBe('Dining');
    expect(plaid.display_name).toBe('My Cafe');
    expect(plaid.ignored).toBe(1);
    expect(await readTxTags(db, 'plaid-1')).toEqual(['travel']);
    expect(await countRows(db, 'transaction_tags', 'transaction_id = ?', ['csv-1'])).toBe(0);
  });

  it("unions tags and keeps the Plaid row's own manual_category over the CSV row's", async () => {
    await seedPair(1, {
      csv: { manual_category: 'Dining', display_name: 'CSV name' },
      plaid: { manual_category: 'Shopping', category: 'Shopping', display_name: 'Plaid name' },
    });
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-1', 1)");
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('plaid-1', 2)");
    await openDupes();
    await userEvent.click(await screen.findByRole('button', { name: 'delete CSV copy' }));
    await waitFor(() => expect(screen.getByText('CSV copy deleted')).toBeTruthy());

    const plaid = (await readTx(db, 'plaid-1'))!;
    expect(plaid.manual_category).toBe('Shopping');
    expect(plaid.category).toBe('Shopping');
    expect(plaid.display_name).toBe('Plaid name');
    expect(await readTxTags(db, 'plaid-1')).toEqual(['travel', 'work']);
  });

  it('Delete all CSV copies removes every CSV row, keeps every Plaid row, and reports the count', async () => {
    await seedPair(1);
    await seedPair(2, { csv: { manual_category: 'Dining' } });
    await openDupes();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all CSV copies' }));
    await waitFor(() => expect(screen.getByText('Deleted 2 duplicates')).toBeTruthy());
    expect(await readTx(db, 'csv-1')).toBeNull();
    expect(await readTx(db, 'csv-2')).toBeNull();
    expect(await readTx(db, 'plaid-1')).not.toBeNull();
    expect((await readTx(db, 'plaid-2'))?.manual_category).toBe('Dining');
    await waitFor(() => expect(screen.getByText('No duplicate candidates found.')).toBeTruthy());
  });

  it('Delete all with a single pair reports the singular status', async () => {
    await seedPair(1);
    await openDupes();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all CSV copies' }));
    await waitFor(() => expect(screen.getByText('Deleted 1 duplicate')).toBeTruthy());
    expect(await readTx(db, 'csv-1')).toBeNull();
  });

  it('pairs one-to-one: two identical CSV rows against ONE Plaid row list only one, and the other survives', async () => {
    await seedTx(db, { id: 'csv-a', account_id: ACCT, source: 'csv', date: '2026-03-01', name: 'Coffee', amount: 5 });
    await seedTx(db, { id: 'csv-b', account_id: ACCT, source: 'csv', date: '2026-03-01', name: 'Coffee', amount: 5 });
    await seedTx(db, { id: 'plaid-x', account_id: ACCT, source: 'plaid', date: '2026-03-01', name: 'Coffee', amount: 5 });
    renderScreen(<Accounts />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dupes (1)' }));
    expect(screen.getAllByRole('button', { name: 'delete CSV copy' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete all CSV copies' }));
    await waitFor(() => expect(screen.getByText('Deleted 1 duplicate')).toBeTruthy());
    // exactly one CSV row consumed, one genuine purchase survives
    expect(await countRows(db, 'transactions', "source = 'csv'")).toBe(1);
    expect(await countRows(db, 'transactions', "source = 'plaid'")).toBe(1);
    // the earlier-inserted row is the one consumed (insertion-order tie-break)
    expect(await readTx(db, 'csv-a')).toBeNull();
    expect(await readTx(db, 'csv-b')).not.toBeNull();
  });

  // The UI only lists paired rows, so the "no Plaid twin" branch of the delete is
  // reachable only if the twin vanishes between listing and click (e.g. a sync
  // removes it). Drive it through the same registry call the buttons use.
  it('deleting a row whose Plaid twin is gone still deletes it, with its tags', async () => {
    await seedTx(db, { id: 'csv-lone', account_id: ACCT, source: 'csv', date: '2026-03-01', name: 'Lone', amount: 9 });
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-lone', 1)");
    await registry.accounts.deleteDuplicate('csv-lone');
    expect(await readTx(db, 'csv-lone')).toBeNull();
    expect(await countRows(db, 'transaction_tags', 'transaction_id = ?', ['csv-lone'])).toBe(0);
  });

  it.each([
    ['a different amount', { amount: 5.01 }],
    ['a gap of more than 3 days', { date: '2026-03-05' }],
  ])('yields no candidate for %s', async (_label, plaidOver) => {
    await seedTx(db, { id: 'csv-n', account_id: ACCT, source: 'csv', date: '2026-03-01', name: 'Coffee', amount: 5 });
    await seedTx(db, { id: 'plaid-n', account_id: ACCT, source: 'plaid', name: 'Coffee', amount: 5, date: '2026-03-01', ...plaidOver });
    await openDupes();
    await userEvent.click(screen.getByRole('button', { name: 'Dupes' }));
    expect(screen.getByText('No duplicate candidates found.')).toBeTruthy();
  });

  it('a gap of exactly 3 days still pairs', async () => {
    await seedTx(db, { id: 'csv-e', account_id: ACCT, source: 'csv', date: '2026-03-01', name: 'Coffee', amount: 5 });
    await seedTx(db, { id: 'plaid-e', account_id: ACCT, source: 'plaid', date: '2026-03-04', name: 'Coffee', amount: 5 });
    renderScreen(<Accounts />);
    expect(await screen.findByRole('button', { name: 'Dupes (1)' })).toBeTruthy();
  });

  // PRODUCT BUG: Accounts.tsx hardcodes the "CSV" source cell and the "CSV copy"
  // button text, but core carries DupePair.csvSource ('csv' | 'manual') through
  // precisely so the review UI can label a hand-entered row as such. A manual
  // entry is mislabelled as a CSV import. Fix: render pair.csvSource ('Manual')
  // in the Source cell and in the button/bar copy; then flip this to a plain `it`.
  it.fails('BUG: labels a manual-source row as manual, not CSV', async () => {
    await seedPair(1, { csv: { source: 'manual' } });
    await openDupes();
    const btn = await screen.findByRole('button', { name: 'delete CSV copy' });
    const cells = Array.from(btn.closest('tr')!.querySelectorAll('td')).map((c) => c.textContent);
    // Source is the second column of the pair's first row.
    expect(cells[1]).toBe('Manual');
  });
});
