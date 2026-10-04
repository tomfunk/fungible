// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { useFixedClock } from '../helpers/fakeClock.js';
import { isoDaysAgo } from '../helpers/dates.js';
import { seedManualAccount, seedCsvAccount, seedPlaidAccount } from '../helpers/balanceFixtures.js';
import { installBridge, renderScreen, type BridgeHarness } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';
import { SyncStatusProvider } from '../../gui/renderer/src/hooks/useSyncStatus.js';
import { clearSyncFailures } from '../../core/sync-status.js';

let bridge: BridgeHarness;

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  // Session state in core/sync-status.ts, not the DB — it would otherwise carry
  // a previous test's failures into the next one's badges.
  clearSyncFailures();
  bridge = installBridge();
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

  // getLinkedAccounts is shared with the TUI, so the GUI table sees the
  // awaiting-first-sync placeholder rows too. It must not render them as a
  // half-empty account row with working edit/delete affordances.
  it('renders a linked-but-unsynced institution as an awaiting-first-sync row', async () => {
    await db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
      args: ['item-new', 'tok', 'Capital One'],
    });
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('◷ awaiting first sync')).toBeTruthy());
    const row = screen.getByText('◷ awaiting first sync').closest('tr')!;
    expect(row.textContent).toContain('Capital One');
    // No mask, no type, and none of the row actions.
    expect(row.textContent).not.toContain('···');
    expect(row.querySelectorAll('button')).toHaveLength(0);
  });

  it('reports the item sync time for an account with no balance snapshot', async () => {
    // Defect-4 guard in the GUI: no balance_history row, but the institution
    // synced 5 minutes ago — the cell must show a time, not "not synced".
    await db.execute('DELETE FROM balance_history');
    await db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
      args: ['item-synced', 'tok', 'Test Bank', Date.now() - 5 * 60_000],
    });
    await db.execute("UPDATE accounts SET item_id = 'item-synced' WHERE id = 'test-checking'");
    renderScreen(<Accounts />);
    const row = await waitFor(() => screen.getByText('Test Checking').closest('tr')!);
    expect(row.textContent).toContain('synced 5 min ago');
    expect(row.textContent).not.toContain('not synced');
  });

  describe('balance age (manual/CSV accounts)', () => {
    useFixedClock();

    async function rowFor(name: string) {
      renderScreen(<Accounts />);
      return waitFor(() => screen.getByText(name).closest('tr')!);
    }

    it('CSV depository at 52 days: "updated 52d ago" in the warning style', async () => {
      await seedCsvAccount(db, { id: 'csv-old', name: 'CSV Old', balanceDaysAgo: 52 });
      const row = await rowFor('CSV Old');
      const label = within(row).getByText('updated 52d ago');
      expect(label.className).toContain('warn');
      expect(row.textContent).not.toContain('not synced');
    });

    it('fresh non-zero age (10d) is muted', async () => {
      await seedCsvAccount(db, { id: 'csv-ten', name: 'CSV Ten', balanceDaysAgo: 10 });
      const label = within(await rowFor('CSV Ten')).getByText('updated 10d ago');
      expect(label.className).toContain('dim');
      expect(label.className).not.toContain('warn');
    });

    it('0 days: "updated today" in the muted style', async () => {
      await seedCsvAccount(db, { id: 'csv-today', name: 'CSV Today', balanceDaysAgo: 0 });
      const label = within(await rowFor('CSV Today')).getByText('updated today');
      expect(label.className).toContain('dim');
      expect(label.className).not.toContain('warn');
    });

    it('1 day: "updated 1d ago"', async () => {
      await seedCsvAccount(db, { id: 'csv-one', name: 'CSV One', balanceDaysAgo: 1 });
      expect(within(await rowFor('CSV One')).getByText('updated 1d ago')).toBeTruthy();
    });

    it('manual investment at 60 days is muted (slow tier, not warn)', async () => {
      await seedManualAccount(db, { id: 'inv', name: 'Manual Brokerage', type: 'investment', subtype: 'brokerage', balanceDaysAgo: 60 });
      const label = within(await rowFor('Manual Brokerage')).getByText('updated 60d ago');
      expect(label.className).toContain('dim');
      expect(label.className).not.toContain('warn');
    });

    it('keeps the "synced" display for Plaid rows', async () => {
      await seedPlaidAccount(db, { id: 'plaid-1', name: 'Plaid Acct', balanceDaysAgo: 3, lastSyncedAt: Date.now() - 5 * 60_000 });
      const row = await rowFor('Plaid Acct');
      expect(row.textContent).not.toContain('updated');
      expect(row.textContent).toContain('synced 5 min ago');
    });

    it('the newest balance_history row drives the label', async () => {
      await seedCsvAccount(db, { id: 'csv-multi', name: 'CSV Multi', balanceDaysAgo: 100 });
      await db.execute({
        sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)',
        args: ['csv-multi', 500, isoDaysAgo(2)],
      });
      const row = await rowFor('CSV Multi');
      const label = within(row).getByText('updated 2d ago');
      expect(label.className).toContain('dim');
      expect(row.textContent).not.toContain('100d');
    });
  });

  it('dupes tab shows the empty state', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /^Dupes/ }));
    await waitFor(() => expect(screen.getByText('No duplicate candidates found.')).toBeTruthy());
  });
});

// The connection actions live on the Links tab (tests/gui/accounts-links.test.tsx);
// the Accounts tab must not still offer them.
describe('GUI Accounts — Links tab', () => {
  const addItem = () =>
    db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
      args: ['item-a', 'tok', 'Chase', Date.now()],
    });

  it('connection actions are not offered from an account row', async () => {
    await addItem();
    await db.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
      args: ['acct-1', 'acct-1', 'item-a'],
    });
    renderScreen(<Accounts />);

    // They moved to the Links tab; the Accounts tab must not still offer them.
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'repair' })).toBeNull();
  });

});
