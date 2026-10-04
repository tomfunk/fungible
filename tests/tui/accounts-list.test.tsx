import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

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
import { useFixedClock } from '../helpers/fakeClock.js';
import { seedManualAccount, seedCsvAccount, seedPlaidAccount } from '../helpers/balanceFixtures.js';
import { useForcedColor, frameHasColor, SGR } from '../helpers/ansi.js';
import { fmtBalanceAge } from '../../core/fmt.js';
import { Accounts } from '../../tui/Accounts.js';
import * as syncApi from '../../core/sync.js';
import * as dedupApi from '../../core/dedup.js';
import { SyncStatusProvider } from '../../tui/SyncStatusContext.js';
import { setSyncResult, clearSyncFailures } from '../../core/sync-status.js';
import { waitFor as baseWaitFor, frame, flatFrame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAccounts, tabTo } from './helpers/accountsScreen.js';

useSeededScreenDb();

describe('Accounts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows seeded accounts after load', async () => {
    const r = renderAccounts();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
      expect(f).toContain('Test Visa');
    });
  });

  it('Tab cycles to Add Data view', async () => {
    const r = renderAccounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('Add Data'));
  });

  // The dupe scan runs detached from loadAccounts so it can't delay the
  // post-link sync. That means the Dupes view can be opened mid-scan, and it
  // must not report a clean result it doesn't have yet.
  describe('dupe scan in flight', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reports the scan as running instead of claiming no duplicates', async () => {
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates').mockImplementation(() => new Promise(() => {}));

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'dupes');
      await waitFor(() => expect(flatFrame(r)).toContain('Checking for duplicates…'));
      expect(flatFrame(r)).not.toContain('No duplicate candidates found.');
    });

    it('reports the clean result once the scan finishes', async () => {
      let finish: (v: never[]) => void = () => {};
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates')
        .mockImplementation(() => new Promise((res) => { finish = res as never; }));

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'dupes');
      await waitFor(() => expect(flatFrame(r)).toContain('Checking for duplicates…'));

      finish([]);
      await waitFor(() => expect(flatFrame(r)).toContain('No duplicate candidates found.'));
    });
  });

  // ── Sync state on the accounts list ───────────────────────────────────────
  //
  // Each case owns the whole list (the seeded accounts are cleared) so a frame
  // assertion is unambiguous about which row it's reading. Frames are whitespace
  // collapsed because a row can wrap at 80 columns.
  describe('sync state', () => {
    beforeEach(async () => {
      await db.execute('DELETE FROM accounts');
      await db.execute('DELETE FROM balance_history');
      await db.execute('DELETE FROM plaid_items');
      clearSyncFailures();
    });
    afterEach(() => clearSyncFailures());

    // The Accounts screen reads failures through SyncStatusProvider; W omits it,
    // so the badge cases need their own wrapper.
    function accountsWithSyncStatus() {
      return render(
        <W>
          <SyncStatusProvider>
            <Accounts onNavigate={noop} showHints={false} />
          </SyncStatusProvider>
        </W>,
      );
    }

    const addItem = (itemId: string, institution: string | null, lastSyncedAt: number | null) =>
      db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
        args: [itemId, 'tok', institution, lastSyncedAt],
      });

    it('renders a placeholder row for a linked but unsynced institution', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = renderAccounts();
      await waitFor(() => {
        const f = flatFrame(r);
        expect(f).toContain('Capital One');
        expect(f).toContain('◷ awaiting first sync');
      });
    });

    // The whole point of the placeholder: a fresh link is never met with
    // "nothing here", which is what nearly caused a duplicate link attempt.
    it('does not show the empty state when only a placeholder exists', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Capital One'));
      expect(flatFrame(r)).not.toContain('No accounts linked yet.');
    });

    it('a failing item outranks the awaiting-first-sync badge', async () => {
      await addItem('item-new', 'Capital One', null);
      setSyncResult([{ itemId: 'item-new', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: 'ITEM_LOGIN_REQUIRED' }]);
      const r = accountsWithSyncStatus();
      await waitFor(() => expect(flatFrame(r)).toContain('⚠ sync failed'));
      // The footer still names the institution as awaiting a first sync — it is.
      // Only the row badge is under test, so match the glyph, not the phrase.
      expect(flatFrame(r)).not.toContain('◷ awaiting first sync');
    });

    it('Enter on a placeholder refuses to open the edit panel and says why', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('◷ awaiting first sync'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Not synced yet'));
      expect(flatFrame(r)).not.toContain('Edit:');
    });

    it('counts placeholders separately from accounts in the footer', async () => {
      const ts = Date.now();
      await addItem('item-synced', 'Chase', ts);
      await addItem('item-new', 'Capital One', null);
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES ('acct-chase', 'Chase Checking', 'depository', 'checking', 'item-synced')`,
        args: [],
      });
      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('1 account · 1 institution awaiting first sync'));
    });

    // Defect 4, end to end: sync writes a balance row only when
    // balances.current is non-null, so this account has no balance_history at
    // all. It used to read "not synced" forever despite its institution syncing
    // fine — it must report the item's sync time instead.
    it('reports the item sync time for a synced account with no balance snapshot', async () => {
      await addItem('item-synced', 'Chase', Date.now() - 5 * 60_000);
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES ('acct-nobal', 'No Balance', 'depository', 'checking', 'item-synced')`,
        args: [],
      });
      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('No Balance'));
      expect(flatFrame(r)).toContain('synced 5 min ago');
      expect(flatFrame(r)).not.toContain('not synced');
    });

    // A long sync must show it is still alive. Without this the label is frozen
    // for the whole run and there's no way to tell working from hung — which is
    // what makes people kill the terminal mid-link.
    it('ticks elapsed seconds while a sync is in flight', async () => {
      // Hold syncAll pending so the syncing state persists long enough to observe.
      vi.spyOn(syncApi, 'syncAll').mockImplementation(() => new Promise(() => {}));

      // Fake only the interval + Date the elapsed counter reads; setTimeout stays
      // real so waitFor polling keeps working.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('No accounts linked yet.'));
        r.stdin.write('s');
        await waitFor(() => expect(flatFrame(r)).toContain('Syncing…'));
        // Suppressed below 2s, then counts up.
        expect(flatFrame(r)).not.toMatch(/Syncing…\s+\d+s/);
        vi.advanceTimersByTime(2100);
        await waitFor(() => expect(flatFrame(r)).toMatch(/Syncing…\s+2s/));
      } finally {
        vi.useRealTimers();
      }
    });

    // The step name has to actually reach the screen, not just be emitted by
    // core — this is the whole point of threading onProgress into the TUI.
    it('renders the current sync step as the sync reports it', async () => {
      vi.spyOn(syncApi, 'syncAll').mockImplementation(async (_force, _ids, onProgress) => {
        onProgress?.('item-x', { phase: 'transactions', page: 1, fetched: 1234 });
        await new Promise((res) => setTimeout(res, 40));
        onProgress?.('item-x', { phase: 'dedup' });
        return new Promise(() => []) as never;   // stay pending on the last step
      });

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('No accounts linked yet.'));
      r.stdin.write('s');
      await waitFor(() => expect(flatFrame(r)).toContain('Fetching transactions… 1,234 so far'));
      await waitFor(() => expect(flatFrame(r)).toContain('Checking for duplicates…'));
    });

    // You can't tell two same-named accounts at different banks apart in the
    // edit panel without this. The account row's own institution_name is NULL
    // for everything Plaid links, so the name has to come from the item.
    it('names the institution in the edit panel, inherited from the item', async () => {
      await addItem('item-chase', 'Chase', Date.now());
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, mask, item_id) VALUES ('acct-plaid', 'Plaid Checking', 'depository', 'checking', '0000', 'item-chase')`,
        args: [],
      });
      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Plaid Checking'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Edit: Plaid Checking'));
      expect(flatFrame(r)).toContain('Chase');
    });

    // Accounts with no Plaid item show their balance age (computed by core) as
    // the freshness signal. Stale (yellow) depends on the account's tier: manual
    // 'other' accounts (house, boat) get the long 120-day tier, so 52 days is
    // NOT stale for them but is for a CSV/manual depository.
    describe('balance age', () => {
      useFixedClock();
      useForcedColor();

      const rawFrame = (r: ReturnType<typeof render>) => r.lastFrame() ?? '';
      /** The rendered line holding `name`, ANSI stripped. */
      const rowOf = (r: ReturnType<typeof render>, name: string) =>
        frame(r).split('\n').find((l) => l.includes(name)) ?? '';

      it('a stale CSV account renders "updated 52d ago" in yellow', async () => {
        await seedCsvAccount(db, { id: 'csv-brokerage', name: 'CSV Savings', balanceDaysAgo: 52 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(fmtBalanceAge({ days: 52, isStale: true } as never)).toBe('updated 52d ago');
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(true);
        expect(rowOf(r, 'CSV Savings')).not.toContain('synced');
      });

      it('a stale manual depository renders "updated 52d ago" in yellow', async () => {
        await seedManualAccount(db, { id: 'manual-cash', name: 'Cash Stash', balanceDaysAgo: 52 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(true);
        expect(rowOf(r, 'Cash Stash')).not.toContain('synced');
      });

      it('a manual "other" account at 52d is in the long tier: same text, not yellow', async () => {
        await seedManualAccount(db, { id: 'manual-house', name: 'House', type: 'other', subtype: null, balanceDaysAgo: 52 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(false);
        expect(rowOf(r, 'House')).not.toContain('synced');
      });

      it('a fresh balance (10d) is not yellow', async () => {
        await seedCsvAccount(db, { id: 'csv-fresh', name: 'Fresh CSV', balanceDaysAgo: 10 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 10d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 10d ago', SGR.yellow)).toBe(false);
      });

      it('a balance from today renders "updated today"', async () => {
        await seedManualAccount(db, { id: 'manual-boat', name: 'Boat', type: 'other', subtype: null, balanceDaysAgo: 0 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated today'));
        expect(fmtBalanceAge({ days: 0, isStale: false } as never)).toBe('updated today');
      });

      it('a balance from yesterday renders "updated 1d ago"', async () => {
        await seedManualAccount(db, { id: 'manual-bike', name: 'Bike', type: 'other', subtype: null, balanceDaysAgo: 1 });
        const r = renderAccounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 1d ago'));
      });

      it('a Plaid-linked account shows "synced", never "updated"', async () => {
        await seedPlaidAccount(db, { id: 'acct-plaid-age', name: 'Plaid Chk', balanceDaysAgo: 52, lastSyncedAt: Date.now() - 5 * 60_000 });
        const r = renderAccounts();
        await waitFor(() => expect(rowOf(r, 'Plaid Chk')).toContain('synced'));
        expect(flatFrame(r)).not.toContain('updated');
      });
    });
  });
});
