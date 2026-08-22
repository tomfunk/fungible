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

  it('dupes tab shows the empty state', async () => {
    renderScreen(<Accounts />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /^Dupes/ }));
    await waitFor(() => expect(screen.getByText('No duplicate candidates found.')).toBeTruthy());
  });
});

// ── Links tab ────────────────────────────────────────────────────────────────
// One row per Plaid connection rather than per account, since a single
// connection can back many accounts. The TUI side of this view is covered in
// tests/tui/screens.test.tsx; these pin the GUI's own rendering of it.
describe('GUI Accounts — Links tab', () => {
  const addItem = (
    itemId: string,
    institution: string | null,
    lastSyncedAt: number | null,
    daysRequested: number | null = null,
  ) =>
    db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested)
            VALUES (?, ?, ?, ?, ?)`,
      args: [itemId, 'tok', institution, lastSyncedAt, daysRequested],
    });

  const addAccount = (id: string, itemId: string) =>
    db.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
      args: [id, id, itemId],
    });

  const addCursor = (itemId: string) =>
    db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: [itemId, 'cur'] });

  /** seedTuiData's accounts are unlinked, so the Links tab starts empty unless a
   *  test seeds its own item. */
  async function links(opts: { syncStatus?: boolean } = {}) {
    const ui = opts.syncStatus ? <SyncStatusProvider><Accounts /></SyncStatusProvider> : <Accounts />;
    renderScreen(ui);
    await userEvent.click(await screen.findByRole('button', { name: /^Links/ }));
  }

  const rowFor = (institution: string) => screen.getByText(institution).closest('tr')!;

  it('empty state points at Add Data', async () => {
    await links();
    await waitFor(() => expect(screen.getByText(/No bank connections yet/)).toBeTruthy());
  });

  it('lists one row per connection, with its account count', async () => {
    await addItem('item-chase', 'Chase', Date.now());
    await addAccount('acct-1', 'item-chase');
    await addAccount('acct-2', 'item-chase');
    await links();

    // Two accounts, one row — the whole point of the view.
    await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
    expect(screen.getAllByText('Chase')).toHaveLength(1);
    expect(rowFor('Chase').textContent).toContain('2');
  });

  it('names the institution as unknown when Plaid gave none', async () => {
    await addItem('item-x', null, Date.now());
    await addAccount('acct-1', 'item-x');
    await links();

    await waitFor(() => expect(screen.getByText('(unknown institution)')).toBeTruthy());
  });

  // Locked at link time — Plaid rejects a wider window on an item that already
  // has Transactions, so the row is reporting a fact the user cannot change.
  it('shows the requested history window', async () => {
    await addItem('item-a', 'Chase', Date.now(), 730);
    await addAccount('acct-1', 'item-a');
    await links();

    await waitFor(() => expect(rowFor('Chase').textContent).toContain('730 days'));
  });

  it('names the default window when none was recorded', async () => {
    await addItem('item-a', 'Chase', Date.now());
    await addAccount('acct-1', 'item-a');
    await links();

    // days_requested is NULL here, which means Plaid's 90-day default applied.
    await waitFor(() => expect(rowFor('Chase').textContent).toContain('90 days (default)'));
  });

  describe('status', () => {
    it('flags a connection awaiting its first sync', async () => {
      // Never synced and no accounts yet — the state right after linking.
      await addItem('item-new', 'Capital One', null);
      await links();

      await waitFor(() => expect(rowFor('Capital One').textContent).toContain('awaiting first sync'));
    });

    it('distinguishes never-synced from awaiting-first-sync', async () => {
      // Accounts but no sync: the item exists in a way a fresh link does not, so
      // it must not claim to be waiting on its first sync.
      await addItem('item-a', 'Chase', null);
      await addAccount('acct-1', 'item-a');
      await links();

      await waitFor(() => expect(rowFor('Chase').textContent).toContain('never synced'));
      expect(rowFor('Chase').textContent).not.toContain('awaiting first sync');
    });

    it('reports when the connection last synced', async () => {
      await addItem('item-a', 'Chase', Date.now() - 5 * 60_000);
      await addAccount('acct-1', 'item-a');
      await links();

      await waitFor(() => expect(rowFor('Chase').textContent).toContain('synced 5 min ago'));
    });

    // The badge is driven by the sync-status push from main, not by the DB, so
    // this exercises the subscription rather than a query.
    it('badges a failing connection on the row and on the tab', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links({ syncStatus: true });
      await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());

      bridge.emit('sync-status', [{ itemId: 'item-a', error: 'ITEM_LOGIN_REQUIRED' }]);

      await waitFor(() => expect(rowFor('Chase').textContent).toContain('sync failed'));
      // The tab itself carries a warning, so the failure is visible from the
      // Accounts tab without opening Links.
      expect(screen.getByRole('button', { name: /^Links/ }).textContent).toContain('⚠');
    });

    it('leaves a healthy connection unbadged', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links({ syncStatus: true });

      await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
      expect(rowFor('Chase').textContent).not.toContain('sync failed');
      expect(screen.getByRole('button', { name: /^Links/ }).textContent).not.toContain('⚠');
    });
  });

  describe('cursor state', () => {
    it('flags a connection with no stored cursor', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links();

      await waitFor(() => expect(screen.getByText(/full replay pending/)).toBeTruthy());
    });

    it('drops the flag once a cursor is stored', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await addCursor('item-a');
      await links();

      await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
      expect(screen.queryByText(/full replay pending/)).toBeNull();
    });

    // A fresh link has no cursor either, but its first sync starts from scratch
    // anyway — saying "full replay pending" there would be noise.
    it('does not flag a connection awaiting its first sync', async () => {
      await addItem('item-new', 'Capital One', null);
      await links();

      await waitFor(() => expect(screen.getByText('Capital One')).toBeTruthy());
      expect(screen.queryByText(/full replay pending/)).toBeNull();
    });
  });

  it('update link opens the Plaid link flow', async () => {
    await addItem('item-a', 'Chase', Date.now());
    await addAccount('acct-1', 'item-a');
    await links();

    await userEvent.click(await screen.findByRole('button', { name: 'update link' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Plaid in browser' })).toBeTruthy());
  });

  it('connection actions are not offered from an account row', async () => {
    await addItem('item-a', 'Chase', Date.now());
    await addAccount('acct-1', 'item-a');
    renderScreen(<Accounts />);

    // They moved to the Links tab; the Accounts tab must not still offer them.
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'repair' })).toBeNull();
  });
});
