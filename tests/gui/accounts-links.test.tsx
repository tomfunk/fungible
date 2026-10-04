// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('./../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// The Links tab's actions all reach Plaid through the real registry, so the
// client is stubbed rather than the bridge — that keeps deleteCursorAndResync's
// composition (delete, then a scoped syncAll, then mergeSyncResult) under test
// instead of mocked away.
vi.mock('../../core/plaid.js', () => ({
  getPlaidClient: vi.fn(),
  plaidErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { db } from '../../core/db.js';
import { getPlaidClient } from '../../core/plaid.js';
import { installBridge, renderScreen, type BridgeHarness } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';
import { SyncStatusProvider } from '../../gui/renderer/src/hooks/useSyncStatus.js';
import { clearSyncFailures } from '../../core/sync-status.js';

/** Plaid returning `added` rows and no removals, the shape a cursor-zero replay
 *  produces. Returns the stub so a test can assert on the cursor it was sent. */
function mockPlaid(added: object[] = []) {
  const transactionsSync = vi.fn().mockResolvedValue({
    data: { added, modified: [], removed: [], has_more: false, next_cursor: 'cursor-1' },
  });
  vi.mocked(getPlaidClient).mockReturnValue({
    transactionsSync,
    accountsGet: vi.fn().mockResolvedValue({ data: { accounts: [] } }),
  } as never);
  return transactionsSync;
}

const tx = (id: string) => ({
  transaction_id: id, account_id: 'acct-1', date: '2026-08-01', name: 'Coffee',
  merchant_name: null, amount: 4.5, pending: false,
  personal_finance_category: { primary: 'FOOD_AND_DRINK' },
});

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

const addCursor = (itemId: string, cursor = 'cur') =>
  db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: [itemId, cursor] });

const storedCursor = async (itemId: string) =>
  (await db.execute({ sql: 'SELECT cursor FROM sync_state WHERE account_id = ?', args: [itemId] })).rows;

/** Renders the screen and switches to the Links tab. */
async function links(opts: { syncStatus?: boolean } = {}) {
  const ui = opts.syncStatus ? <SyncStatusProvider><Accounts /></SyncStatusProvider> : <Accounts />;
  renderScreen(ui);
  await userEvent.click(await screen.findByRole('button', { name: /^Links/ }));
}

const rowFor = (institution: string) => screen.getByText(institution).closest('tr')!;

/** One synced connection with two accounts and a stored cursor — the state in
 *  which the action is offered. */
async function seedSyncedItem() {
  await addItem('item-a', 'Chase', Date.now());
  await addAccount('acct-1', 'item-a');
  await addAccount('acct-2', 'item-a');
  await addCursor('item-a');
}

let bridge: BridgeHarness;

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts',
                     'balance_history', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  // Session state in core/sync-status.ts, not the DB — it would otherwise carry
  // a previous test's failures into the next one's badges.
  clearSyncFailures();
  bridge = installBridge();
});

afterEach(() => cleanup());

// ── Links tab ────────────────────────────────────────────────────────────────
// One row per Plaid connection rather than per account, since a single
// connection can back many accounts. The TUI side of this view is covered in
// tests/tui/screens.test.tsx; these pin the GUI's own rendering of it.
describe('GUI Accounts — Links tab', () => {
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

      await waitFor(() => expect(screen.getByText(/sync cursor cleared/)).toBeTruthy());
    });

    it('drops the flag once a cursor is stored', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await addCursor('item-a');
      await links();

      await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
      expect(screen.queryByText(/sync cursor cleared/)).toBeNull();
    });

    // A fresh link has no cursor either, but its first sync starts from scratch
    // anyway — saying "sync cursor cleared" there would be noise, and there is
    // no cursor to delete, so the action is not offered either.
    it('does not flag a connection awaiting its first sync', async () => {
      await addItem('item-new', 'Capital One', null);
      await links();

      await waitFor(() => expect(screen.getByText('Capital One')).toBeTruthy());
      expect(screen.getByText(/awaiting first sync/)).toBeTruthy();
      expect(screen.queryByText(/sync cursor cleared/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'delete sync cursor' })).toBeNull();
    });
  });

  // Refresh drives core/transactions-refresh.ts over the dedicated 'sync:refresh'
  // IPC channel (not the registry), so these register a handler on the harness's
  // invoke and assert the confirm gate + reporting, mirroring the TUI's [r] tests.
  describe('refresh', () => {
    it('confirms and names the Plaid charge before calling refresh', async () => {
      const spy = vi.fn();
      bridge.onInvoke('sync:refresh', spy);
      await addItem('item-a', 'Chase', Date.now(), 730);
      await addAccount('acct-1', 'item-a');
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'refresh' }));

      await waitFor(() => expect(screen.getByText(/Plaid charges for each refresh/)).toBeTruthy());
      // The window is named from days_requested so the limit isn't left abstract.
      expect(screen.getByText(/730-day history window/)).toBeTruthy();
      // Nothing billed until the user confirms.
      expect(spy).not.toHaveBeenCalled();
    });

    it('Cancel backs out without spending a refresh', async () => {
      const spy = vi.fn();
      bridge.onInvoke('sync:refresh', spy);
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'refresh' }));
      await waitFor(() => expect(screen.getByText(/Plaid charges for each refresh/)).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByText(/Plaid charges for each refresh/)).toBeNull());
      expect(spy).not.toHaveBeenCalled();
    });

    it('Yes refreshes the selected item and reports the outcome', async () => {
      bridge.onInvoke('sync:refresh', async (itemId) => ({
        itemId, added: 0, modified: 0, removed: 0, checks: 4, cancelled: false, syncResults: [],
      }));
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'refresh' }));
      await waitFor(() => expect(screen.getByText(/Plaid charges for each refresh/)).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Yes, refresh' }));

      // The no-luck copy never claims completion — the refresh may still be
      // running at the bank, and this view can't tell.
      await waitFor(() => expect(screen.getByText(/No new transactions yet/)).toBeTruthy());
    });

    it('keeps the modal open with a Stop button while the poll runs', async () => {
      // Never resolves: the poll is still in flight, so the modal must stay up.
      bridge.onInvoke('sync:refresh', () => new Promise(() => {}));
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'refresh' }));
      await waitFor(() => expect(screen.getByText(/Plaid charges for each refresh/)).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Yes, refresh' }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Stop checking' })).toBeTruthy());
      // The gate's confirm button is gone once the poll owns the modal.
      expect(screen.queryByRole('button', { name: 'Yes, refresh' })).toBeNull();
    });

    it('Stop cancels the in-flight poll', async () => {
      const cancel = vi.fn();
      bridge.onInvoke('sync:refresh', () => new Promise(() => {}));
      bridge.onInvoke('sync:refresh-cancel', cancel);
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'refresh' }));
      await waitFor(() => expect(screen.getByText(/Plaid charges for each refresh/)).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Yes, refresh' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Stop checking' }));

      expect(cancel).toHaveBeenCalledWith('item-a');
    });
  });

  describe('delete sync cursor', () => {
    it('offers the action on a connection row', async () => {
      await seedSyncedItem();
      await links();
      await waitFor(() => expect(screen.getByRole('button', { name: 'delete sync cursor' })).toBeTruthy());
    });

    // Costs nothing at Plaid, so the gate is not about the bill: the replay
    // resurrects transactions the user deleted on purpose.
    it('asks for confirmation before deleting anything', async () => {
      await seedSyncedItem();
      const plaid = mockPlaid();
      await links();

      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));

      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());
      // Item-scoped, and the modal says so rather than implying one account.
      expect(screen.getByText(/all 2 accounts on this connection/)).toBeTruthy();
      expect(plaid).not.toHaveBeenCalled();
      expect(await storedCursor('item-a')).toHaveLength(1);
    });

    it('warns that hand-deleted transactions come back, and that Plaid gaps stay', async () => {
      await seedSyncedItem();
      mockPlaid();
      await links();
      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));

      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());
      expect(screen.getByText(/Transactions you deleted by hand will come back/)).toBeTruthy();
      expect(screen.getByText(/Transactions Plaid no longer has will not/)).toBeTruthy();
      // The reason to reach for this rather than a billed refresh.
      expect(screen.getByText(/Free/)).toBeTruthy();
    });

    it('Cancel backs out without touching the cursor', async () => {
      await seedSyncedItem();
      const plaid = mockPlaid();
      await links();
      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));
      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByText('Delete sync cursor and resync')).toBeNull());
      expect(plaid).not.toHaveBeenCalled();
      expect(await storedCursor('item-a')).toHaveLength(1);
    });

    it('confirming deletes the cursor and resyncs from the beginning of the feed', async () => {
      await seedSyncedItem();
      const plaid = mockPlaid([tx('tx-9')]);
      await links();
      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));
      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: 'Delete cursor and resync' }));

      await waitFor(() => expect(screen.getByText(/re-downloaded 1 transaction/)).toBeTruthy());
      // The point of the feature: the resync starts from cursor zero, not from
      // where the last sync left off.
      expect(plaid).toHaveBeenCalledTimes(1);
      expect(plaid.mock.calls[0][0]).toMatchObject({ cursor: undefined });
      // And the row Plaid resent actually landed.
      const rows = await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: ['tx-9'] });
      expect(rows.rows).toHaveLength(1);
    });

    // "N new transactions" would be a lie: a cursor-zero replay reports every
    // row Plaid holds as added, most of which the database already had.
    it('reports the count as re-downloaded rather than new', async () => {
      await seedSyncedItem();
      mockPlaid([tx('tx-1'), tx('tx-2')]);
      await links();
      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));
      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: 'Delete cursor and resync' }));

      await waitFor(() => expect(screen.getByText(/re-downloaded 2 transactions/)).toBeTruthy());
      expect(screen.queryByText(/2 new transactions/)).toBeNull();
    });

    it('reports a failed resync instead of claiming success', async () => {
      await seedSyncedItem();
      vi.mocked(getPlaidClient).mockReturnValue({
        transactionsSync: vi.fn().mockRejectedValue(new Error('ITEM_LOGIN_REQUIRED')),
        accountsGet: vi.fn().mockResolvedValue({ data: { accounts: [] } }),
      } as never);
      await links();
      await userEvent.click(await screen.findByRole('button', { name: 'delete sync cursor' }));
      await waitFor(() => expect(screen.getByText('Delete sync cursor and resync')).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: 'Delete cursor and resync' }));

      await waitFor(() => expect(screen.getByText(/Resync failed: Chase/)).toBeTruthy());
      expect(screen.getByText(/ITEM_LOGIN_REQUIRED/)).toBeTruthy();
      // The cursor is gone either way, which the row badge now reflects — the
      // next sync will still start from the beginning.
      expect(await storedCursor('item-a')).toHaveLength(0);
    });
  });
});
