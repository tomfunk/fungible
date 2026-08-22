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
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

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

const addItem = (itemId: string, institution: string | null, lastSyncedAt: number | null) =>
  db.execute({
    sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
    args: [itemId, 'tok', institution, lastSyncedAt],
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
async function links() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: 'Links' }));
}

/** One synced connection with two accounts and a stored cursor — the state in
 *  which the action is offered. */
async function seedSyncedItem() {
  await addItem('item-a', 'Chase', Date.now());
  await addAccount('acct-1', 'item-a');
  await addAccount('acct-2', 'item-a');
  await addCursor('item-a');
}

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts',
                     'balance_history', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Accounts — Links tab', () => {
  it('lists one row per connection, with its account count', async () => {
    await seedSyncedItem();
    await links();
    // Two accounts, one row — the whole point of the view.
    await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
    const row = screen.getByText('Chase').closest('tr')!;
    expect(row.textContent).toContain('2');
  });

  it('flags a connection with no stored cursor', async () => {
    await addItem('item-a', 'Chase', Date.now());
    await addAccount('acct-1', 'item-a');
    await links();
    await waitFor(() => expect(screen.getByText(/sync cursor cleared/)).toBeTruthy());
  });

  it('drops the flag once a cursor is stored', async () => {
    await seedSyncedItem();
    await links();
    await waitFor(() => expect(screen.getByText('Chase')).toBeTruthy());
    expect(screen.queryByText(/sync cursor cleared/)).toBeNull();
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

    it('is not offered on a connection still awaiting its first sync', async () => {
      // That sync starts from scratch already, so there is no cursor to delete.
      await addItem('item-new', 'Capital One', null);
      await links();

      await waitFor(() => expect(screen.getByText(/awaiting first sync/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'delete sync cursor' })).toBeNull();
    });
  });
});
