import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import * as syncApi from '../../core/sync.js';
import * as refreshApi from '../../core/transactions-refresh.js';
import * as keyHealthApi from '../../core/key-health.js';
import { waitFor as baseWaitFor, flatFrame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAccounts, tabTo } from './helpers/accountsScreen.js';

useSeededScreenDb();

describe('Accounts', () => {
  afterEach(() => vi.restoreAllMocks());

  // ── Links tab ──────────────────────────────────────────────────────────────
  // Connection-level view: one row per Plaid item, not per account. The actions
  // that belong to an item (updating its credentials now, replacing a connection
  // later) live here rather than on an account row, where they implied a scope
  // they never had.
  describe('links tab', () => {
    beforeEach(async () => {
      await db.execute('DELETE FROM accounts');
      await db.execute('DELETE FROM plaid_items');
      await db.execute('DELETE FROM sync_state');
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

    it('lists one row per connection, with its account count', async () => {
      await addItem('item-chase', 'Chase', Date.now());
      await addAccount('acct-1', 'item-chase');
      await addAccount('acct-2', 'item-chase');

      const r = renderAccounts();
      await tabTo(r, 'links');
      const f = flatFrame(r);
      // Two accounts, one row — the whole point of the view.
      expect(f).toContain('Chase');
      expect(f).toContain('2 accounts');
      expect(f).toContain('1 connection');
    });

    it('shows the history window, and names the default when none was recorded', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = renderAccounts();
      await tabTo(r, 'links');
      // days_requested is NULL here, which means Plaid's 90-day default applied.
      expect(flatFrame(r)).toContain('90d (default)');
    });

    it('flags a connection awaiting its first sync', async () => {
      await addItem('item-new', 'Capital One', null);

      const r = renderAccounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('awaiting first sync');
    });

    it('flags a connection with no stored cursor', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = renderAccounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('sync cursor cleared');
    });

    it('drops the flag once a cursor is stored', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: ['item-a', 'cur'] });

      const r = renderAccounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).not.toContain('sync cursor cleared');
    });

    // [u] update link is exercised in accounts-update-link.test.tsx, which mocks
    // the spawn it triggers and asserts the same hint on a connection row.

    it('empty state points at Add Data', async () => {
      const r = renderAccounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('No bank connections yet.');
    });

    it('the link action is no longer offered from an account row', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = renderAccounts({ showHints: true });
      await waitFor(() => expect(flatFrame(r)).toContain('acct-1'));
      // It moved to the Links tab; the accounts hint must not still advertise it.
      expect(flatFrame(r)).not.toContain('update link');
      expect(flatFrame(r)).not.toContain('repair link');
    });

    // ── Refresh ([r]) ─────────────────────────────────────────────────────────
    // Plaid bills per /transactions/refresh call, so the confirmation gate is as
    // much a part of the feature as the keypress. [r] was "repair link" until
    // update mode renamed it to [u], which is a second reason nothing may fire
    // on the bare keypress.
    describe('refresh ([r])', () => {
      /** Puts the cursor on a connection row with the refresh action available. */
      async function linksWithItem(days: number | null = null) {
        await db.execute({
          sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested) VALUES (?, ?, ?, ?, ?)',
          args: ['item-a', 'tok', 'Chase', Date.now(), days],
        });
        await addAccount('acct-1', 'item-a');
        await addAccount('acct-2', 'item-a');
      }

      it('advertises [r] on a connection row', async () => {
        await linksWithItem();
        const r = renderAccounts();
        await tabTo(r, 'links');
        expect(flatFrame(r)).toContain('[r] refresh');
      });

      it('asks for confirmation and says Plaid charges before doing anything', async () => {
        await linksWithItem();
        const spy = vi.spyOn(refreshApi, 'refreshTransactions');

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');

        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        // Item-scoped, and the panel says so rather than implying one account.
        expect(flatFrame(r)).toContain('all 2 accounts on this connection');
        expect(spy).not.toHaveBeenCalled();
      });

      it('names the connection history window it cannot reach past', async () => {
        await linksWithItem(730);
        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');

        await waitFor(() => expect(flatFrame(r)).toContain('730-day history window'));
      });

      it('[n] backs out without spending a refresh', async () => {
        await linksWithItem();
        const spy = vi.spyOn(refreshApi, 'refreshTransactions');

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');
        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        r.stdin.write('n');

        await waitFor(() => expect(flatFrame(r)).not.toContain('Plaid charges for each refresh'));
        expect(spy).not.toHaveBeenCalled();
      });

      it('[y] refreshes the selected item and reports it as requested, not complete', async () => {
        await linksWithItem();
        let report: ((p: refreshApi.RefreshProgress) => void) | undefined;
        vi.spyOn(refreshApi, 'refreshTransactions').mockImplementation((_id, opts) => {
          report = opts?.onProgress;
          return new Promise(() => {});   // still polling; the tab stays in-flight
        });

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');
        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        r.stdin.write('y');

        await waitFor(() => expect(flatFrame(r)).toContain('Asking your bank'));
        expect(refreshApi.refreshTransactions).toHaveBeenCalledWith('item-a', expect.anything());

        report?.({ phase: 'waiting', attempt: 1, attempts: 4, until: Date.now() + 15_000 });
        await waitFor(() => {
          const f = flatFrame(r);
          expect(f).toContain('Refresh requested');
          expect(f).toContain('check 1 of 4');
          expect(f.toLowerCase()).not.toContain('refresh complete');
        });
      });

      it('reports the outcome when the poll finds nothing', async () => {
        await linksWithItem();
        vi.spyOn(refreshApi, 'refreshTransactions').mockResolvedValue({
          itemId: 'item-a', added: 0, modified: 0, removed: 0, checks: 4, cancelled: false, syncResults: [],
        });

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');
        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        r.stdin.write('y');

        await waitFor(() => expect(flatFrame(r)).toContain('No new transactions yet'));
      });

      it('Esc aborts an in-flight poll instead of leaving the tab', async () => {
        await linksWithItem();
        let started = false;
        vi.spyOn(refreshApi, 'refreshTransactions').mockImplementation((id, opts) => {
          started = true;
          return new Promise((resolve) => {
            opts?.signal?.addEventListener('abort', () => resolve({
              itemId: id, added: 0, modified: 0, removed: 0, checks: 1, cancelled: true, syncResults: [],
            }));
          });
        });

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');
        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        r.stdin.write('y');
        await waitFor(() => expect(started).toBe(true));

        r.stdin.write('\x1b');
        await waitFor(() => expect(flatFrame(r)).toContain('Stopped checking'));
        // Still on Links — Esc was consumed by the poll, not by the tab.
        expect(flatFrame(r)).toContain('[u] update link');
      });

      // The steer that makes [r] vs [d] a real choice rather than two buttons.
      it('points at [d] for the restore case rather than selling a refresh', async () => {
        await linksWithItem();
        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');

        await waitFor(() => expect(flatFrame(r)).toContain('Trying to get back transactions you deleted'));
        const f = flatFrame(r);
        expect(f).toContain('[d] delete sync cursor');
        // The whole reason to steer: the alternative is not billed.
        expect(f).toContain('free');
      });

      // Cancelling only to press [d] is pure friction, so the confirmation takes
      // it directly.
      it('[d] from the refresh confirmation opens the cursor confirmation instead', async () => {
        await linksWithItem();
        const spy = vi.spyOn(refreshApi, 'refreshTransactions');

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('r');
        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        r.stdin.write('d');

        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        expect(flatFrame(r)).not.toContain('Plaid charges for each refresh');
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // ── Delete sync cursor ([d]) ──────────────────────────────────────────────
    // Costs nothing at Plaid, so the confirmation is not about the bill: a
    // cursor-zero replay resurrects transactions the user deleted on purpose,
    // and that is the surprise the gate exists to prevent.
    describe('delete sync cursor ([d])', () => {
      async function linksWithSyncedItem() {
        await addItem('item-a', 'Chase', Date.now());
        await addAccount('acct-1', 'item-a');
        await addAccount('acct-2', 'item-a');
        await db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: ['item-a', 'cur'] });
      }

      it('advertises [d] on a connection row', async () => {
        await linksWithSyncedItem();
        const r = renderAccounts();
        await tabTo(r, 'links');
        expect(flatFrame(r)).toContain('[d] delete sync cursor');
      });

      it('asks for confirmation before deleting anything', async () => {
        await linksWithSyncedItem();
        const spy = vi.spyOn(syncApi, 'deleteSyncCursor');

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('d');

        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        // Item-scoped, and the panel says so rather than implying one account.
        expect(flatFrame(r)).toContain('all 2 accounts on this connection');
        expect(spy).not.toHaveBeenCalled();
      });

      it('warns that hand-deleted transactions come back, and that Plaid gaps stay', async () => {
        await linksWithSyncedItem();
        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('d');

        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        const f = flatFrame(r);
        expect(f).toContain('Transactions you deleted by hand will come back');
        expect(f).toContain('Transactions Plaid no longer has will not');
        // The reason to reach for this over [r]: it does not cost anything.
        expect(f).toContain('Free');
      });

      it('[n] backs out without touching the cursor', async () => {
        await linksWithSyncedItem();
        const spy = vi.spyOn(syncApi, 'deleteSyncCursor');

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('d');
        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        r.stdin.write('n');

        await waitFor(() => expect(flatFrame(r)).not.toContain('Delete sync cursor and resync'));
        expect(spy).not.toHaveBeenCalled();
        const rows = await db.execute({ sql: 'SELECT cursor FROM sync_state WHERE account_id = ?', args: ['item-a'] });
        expect(rows.rows).toHaveLength(1);
      });

      it('[y] deletes the cursor and resyncs just that item', async () => {
        await linksWithSyncedItem();
        vi.spyOn(syncApi, 'syncAll').mockResolvedValue([
          { itemId: 'item-a', added: 1234, modified: 0, removed: 0, dupes: 0, skipped: false },
        ]);

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('d');
        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        r.stdin.write('y');

        await waitFor(() => expect(flatFrame(r)).toContain('re-downloaded 1,234 transactions'));
        // Scoped to the selected item, and forced past the 15-minute debounce.
        expect(syncApi.syncAll).toHaveBeenCalledWith(true, ['item-a'], expect.anything());
        // The cursor really went, rather than the UI merely claiming it did.
        const rows = await db.execute({ sql: 'SELECT cursor FROM sync_state WHERE account_id = ?', args: ['item-a'] });
        expect(rows.rows).toHaveLength(0);
      });

      // "N new transactions" would be a lie here: a cursor-zero replay reports
      // every row Plaid holds as added, most of which the database already had.
      it('reports the count as re-downloaded rather than new', async () => {
        await linksWithSyncedItem();
        vi.spyOn(syncApi, 'syncAll').mockResolvedValue([
          { itemId: 'item-a', added: 900, modified: 0, removed: 0, dupes: 0, skipped: false },
        ]);

        const r = renderAccounts();
        await tabTo(r, 'links');
        r.stdin.write('d');
        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        r.stdin.write('y');

        await waitFor(() => expect(flatFrame(r)).toContain('re-downloaded 900 transactions'));
        expect(flatFrame(r)).not.toContain('900 new transactions');
      });

      it('does nothing on a connection still awaiting its first sync', async () => {
        // That sync starts from scratch already, so there is no cursor to delete.
        await addItem('item-new', 'Capital One', null);
        const spy = vi.spyOn(syncApi, 'deleteSyncCursor');

        const r = renderAccounts();
        await tabTo(r, 'links');
        await waitFor(() => expect(flatFrame(r)).toContain('awaiting first sync'));
        r.stdin.write('d');

        await new Promise((res) => setTimeout(res, 50));
        expect(flatFrame(r)).not.toContain('Delete sync cursor and resync');
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // A lost or swapped encryption key (issue #179) silently breaks every Plaid
    // connection at once, so it gets a persistent banner above the Links list
    // rather than a per-row badge. checkKeyHealth is mocked here rather than
    // exercised through the real key file / plaid_items decrypt path — that
    // logic is core's, covered by core's own tests.
    describe('encryption key health banner', () => {
      afterEach(() => vi.restoreAllMocks());

      it('shows no banner when the key is healthy', async () => {
        vi.spyOn(keyHealthApi, 'checkKeyHealth').mockResolvedValue({ ok: true });

        const r = renderAccounts();
        await tabTo(r, 'links');
        await waitFor(() => expect(flatFrame(r)).toContain('connection'));
        expect(flatFrame(r)).not.toContain('Encryption key');
      });

      it('flags a missing key file with the affected account count', async () => {
        vi.spyOn(keyHealthApi, 'checkKeyHealth').mockResolvedValue({
          ok: false, reason: 'missing_key', linkedAccountCount: 2,
        });

        const r = renderAccounts();
        await tabTo(r, 'links');
        await waitFor(() => {
          const f = flatFrame(r);
          expect(f).toContain('Encryption key missing');
          expect(f).toContain("2 linked accounts can't sync");
        });
      });

      it('flags a key that no longer decrypts stored tokens, singular count', async () => {
        vi.spyOn(keyHealthApi, 'checkKeyHealth').mockResolvedValue({
          ok: false, reason: 'decrypt_failed', linkedAccountCount: 1,
        });

        const r = renderAccounts();
        await tabTo(r, 'links');
        await waitFor(() => {
          const f = flatFrame(r);
          expect(f).toContain("Encryption key doesn't match this database");
          expect(f).toContain('1 linked account may need re-linking');
        });
      });
    });
  });
});
