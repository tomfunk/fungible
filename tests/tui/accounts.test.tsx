import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { spawn } from 'node:child_process';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// tui/Accounts.tsx is the only TUI screen that spawns anything (scripts/link.ts),
// so stubbing spawn lets the link panel be driven without a real subprocess.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
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
import { Transactions } from '../../tui/Transactions.js';
import { Accounts, extractLinkUrl } from '../../tui/Accounts.js';
import * as accountsApi from '../../core/accounts.js';
import * as refreshApi from '../../core/transactions-refresh.js';
import * as syncApi from '../../core/sync.js';
import * as dedupApi from '../../core/dedup.js';
import * as keyHealthApi from '../../core/key-health.js';
import { SyncStatusProvider } from '../../tui/SyncStatusContext.js';
import { setSyncResult, clearSyncFailures } from '../../core/sync-status.js';
import { waitFor, frame, flatFrame } from '../helpers/waitFor.js';
import { fakeLinkProcess, W, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { loadProfile, saveProfile } from '../../core/profile.js';

useSeededScreenDb();

describe('Accounts', () => {
  function accounts(overrides?: Partial<Parameters<typeof Accounts>[0]>) {
    return render(
      <W>
        <Accounts onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  /**
   * Tab from Accounts to a named view, so tests don't hard-code how many tabs
   * sit between them. Asserting on view-specific content matters here: every
   * tab's label is in the header on every view, so waiting for "Add Data" would
   * pass without having navigated anywhere.
   */
  const VIEW_MARKER = {
    links: 'connection',                 // Links panel footer, or its empty state
    'add-data': '[l] Link a bank account',
    dupes: 'duplicate',                  // "No duplicate candidates found." / "Checking for duplicates…"
  } as const;

  async function tabTo(r: ReturnType<typeof render>, view: keyof typeof VIEW_MARKER) {
    const order = ['links', 'add-data', 'dupes'] as const;
    for (let i = 0; i <= order.indexOf(view); i++) {
      r.stdin.write('\t');
      // Consecutive writes coalesce into one chunk, which ink reads as a single
      // Tab — the gap keeps each press its own input event.
      await new Promise((res) => setTimeout(res, 10));
    }
    await waitFor(() => expect(flatFrame(r)).toContain(VIEW_MARKER[view]));
  }

  it('shows seeded accounts after load', async () => {
    const r = accounts();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
      expect(f).toContain('Test Visa');
    });
  });

  it('Tab cycles to Add Data view', async () => {
    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('Add Data'));
  });

  // Regression guards for the stale-list bug: the mutation DB calls are async, so
  // the list must reload only AFTER the write commits. The handlers must await the
  // write before calling loadAccounts(); otherwise the reload reads pre-mutation
  // data and the list never reflects the change.
  //
  // In-memory libsql applies an un-awaited write before the next read, so the race
  // can't be observed at face value. We reproduce the real-world DB latency by
  // delaying the write ~60ms: with the bug, loadAccounts() reads stale data while
  // the write is still in flight and the list never updates; with the fix, the
  // reload is chained off the write and shows fresh data.
  const WRITE_DELAY = 60;
  function delayWrite<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
    return (...args: A): Promise<R> =>
      new Promise((res) => setTimeout(res, WRITE_DELAY)).then(() => fn(...args));
  }
  afterEach(() => vi.restoreAllMocks());

  it('setting a nickname refreshes the list to show the new nickname', async () => {
    const real = accountsApi.updateAccountNickname;
    vi.spyOn(accountsApi, 'updateAccountNickname').mockImplementation(delayWrite(real));

    const r = accounts();
    // Cursor starts on the first account (depository sorts first = Test Checking).
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('Vacation Fund');     // type the nickname (cursor starts on Nickname field)
    await waitFor(() => expect(frame(r)).toContain('Vacation Fund'));
    r.stdin.write('\r');                // save
    // The list row now shows the nickname in place of the account name. Asserting
    // the original name is gone proves the list reloaded with post-write data (the
    // status toast shows the nickname, not the original name).
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Vacation Fund');
      expect(f).not.toContain('Test Checking');
    });
  });

  it('toggling "exclude from net worth" refreshes the list with the excl marker', async () => {
    const real = accountsApi.updateAccountExcluded;
    vi.spyOn(accountsApi, 'updateAccountExcluded').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                            // open unified edit panel (cursor on Nickname)
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    expect(frame(r)).toContain('Included');         // Net-worth toggle defaults to Included
    // Fields for a depository with no household members: Nickname, Type, Subtype, Net worth.
    r.stdin.write('\x1b[B');                         // ↓ Nickname → Type
    r.stdin.write('\x1b[B');                         // ↓ Type → Subtype
    r.stdin.write('\x1b[B');                         // ↓ Subtype → Net worth
    // Let the field-change commit before toggling: the toggle reads editField from
    // its closure, which is stale if the right-arrow runs in the same input batch.
    await new Promise((res) => setTimeout(res, 60));
    r.stdin.write('\x1b[C');                         // → toggle to Excluded
    await waitFor(() => expect(frame(r)).toContain('Excluded'));
    r.stdin.write('\r');                             // save
    await waitFor(() => expect(frame(r)).toContain('excl')); // ⊘ excl row marker after reload
  });

  it('deleting an account refreshes the list to drop it', async () => {
    const real = accountsApi.deleteAccount;
    vi.spyOn(accountsApi, 'deleteAccount').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
      expect(f).toContain('2 accounts');
    });
    r.stdin.write('x');                 // confirm-delete panel
    await waitFor(() => expect(frame(r)).toContain('this cannot be undone'));
    r.stdin.write('y');                 // confirm
    // The account-count line reflects the reloaded list independently of the
    // "Deleted …" status toast (which still mentions the deleted account name).
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('1 account');
      expect(f).toContain('Test Visa');
    });
  });

  it('surfaces an error and leaves the list unchanged when a write fails', async () => {
    vi.spyOn(accountsApi, 'updateAccountNickname').mockRejectedValue(new Error('db down'));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('Vacation Fund');
    await waitFor(() => expect(frame(r)).toContain('Vacation Fund'));
    r.stdin.write('\r');                 // save → write rejects
    // A failed write must show an error rather than a (false) success, and the
    // account must keep its original name.
    await waitFor(() => expect(frame(r)).toContain('Failed to update'));
    const f = frame(r);
    expect(f).toContain('Test Checking');
    expect(f).not.toContain('Updated Vacation Fund');
  });

  it('setting an owner refreshes the list to show the owner on the account row', async () => {
    // The owner editor cycles over household members, so a profile must supply one.
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Alex Stark', birthYear: 0 }, children: [] });
    const real = accountsApi.updateAccountOwner;
    vi.spyOn(accountsApi, 'updateAccountOwner').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel (Nickname field active)
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('\x1b[B');             // ↓ Nickname → Owner
    await waitFor(() => expect(frame(r)).toContain('Unassigned')); // owner toggle, default Unassigned
    r.stdin.write('\x1b[C');             // → cycle Unassigned → Alex Stark
    await waitFor(() => expect(frame(r)).toContain('← Alex Stark'));
    r.stdin.write('\r');                 // save (separate chunk so it isn't merged)
    // The success toast is "Updated Test Checking" (it doesn't echo the owner), so
    // the owner appearing on the row proves the list reloaded after the write — under
    // the stale-list bug the row would still be ownerless. Whitespace is collapsed
    // first because the owner can wrap across lines in the account row.
    await waitFor(() => {
      const flat = frame(r).replace(/\s+/g, ' ');
      expect(flat).toContain('Alex Stark');
    });
  });

  it('surfaces an error and does not apply the owner when the write fails', async () => {
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Alex Stark', birthYear: 0 }, children: [] });
    vi.spyOn(accountsApi, 'updateAccountOwner').mockRejectedValue(new Error('db down'));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('\x1b[B');             // ↓ Nickname → Owner
    await waitFor(() => expect(frame(r)).toContain('Unassigned'));
    r.stdin.write('\x1b[C');             // → cycle to Alex Stark
    await waitFor(() => expect(frame(r)).toContain('← Alex Stark'));
    r.stdin.write('\r');                 // save → write rejects
    await waitFor(() => expect(frame(r)).toContain('Failed to update'));
    expect(frame(r)).not.toContain('Updated Test Checking');
  });

  // The link URL is printed once by scripts/link.ts and then buried by later
  // status lines ("Waiting for you to connect…"), which share the single
  // linkMsg slot. It has to be captured from the chunk and pinned separately —
  // on Linux there is no `open`, so it is the only way into the Plaid flow.
  describe('link URL capture', () => {
    it('pins an https origin when an OAuth redirect is configured', () => {
      expect(extractLinkUrl('Opening https://localhost:4747 …')).toBe('https://localhost:4747');
    });

    it('extracts the URL from the line link.ts prints', () => {
      expect(extractLinkUrl('Opening http://localhost:4747 …')).toBe('http://localhost:4747');
    });

    it('finds the URL anywhere in a multi-line chunk, not just the last line', () => {
      const chunk = 'Opening http://localhost:4747 …\nWaiting for you to connect in the browser…\n';
      // The last line is what becomes linkMsg, so a last-line-only scan would miss it.
      expect(chunk.trim().split('\n').pop()).not.toContain('localhost');
      expect(extractLinkUrl(chunk)).toBe('http://localhost:4747');
    });

    it('returns null for status lines that carry no URL', () => {
      expect(extractLinkUrl('Saving institution…')).toBeNull();
      expect(extractLinkUrl('Creating Plaid link token…')).toBeNull();
    });

    it('reads whatever port link.ts is using rather than assuming one', () => {
      expect(extractLinkUrl('Opening http://localhost:8080 …')).toBe('http://localhost:8080');
    });

    // The regression the user hit: the URL scrolled away behind the next status
    // line, leaving nothing to click while the ticker counted up.
    it('keeps the URL on screen after later status lines replace the message', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');                                   // → history-window prompt
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');                                  // → starts the link
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.stdout.emit('data', Buffer.from('Opening http://localhost:4747 …\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('http://localhost:4747'));

      // This line takes over linkMsg — the URL must survive it.
      proc.stdout.emit('data', Buffer.from('Waiting for you to connect in the browser…\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('Waiting for you to connect'));
      expect(flatFrame(r)).toContain('http://localhost:4747');

      // Still there several status lines later.
      proc.stdout.emit('data', Buffer.from('Account link received from Chase — exchanging token…\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('exchanging token'));
      expect(flatFrame(r)).toContain('http://localhost:4747');
    });

    // Same defect shape: the generic exit-code line used to bury the stderr
    // reason, so a crash reported only that it happened, never why.
    it('keeps the stderr reason instead of replacing it with the exit code', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use 127.0.0.1:4747\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('EADDRINUSE'));
      proc.emit('close', 1);

      await waitFor(() => expect(flatFrame(r)).toContain('Press Enter to return.'));
      expect(flatFrame(r)).toContain('EADDRINUSE');
      expect(flatFrame(r)).not.toContain('Process exited with code 1');
    });

    // The post-link sync runs while the link panel is still on screen. It used
    // to render only linkMsg, so every sync step was invisible and the elapsed
    // counter sat next to the finished link message — indistinguishable from a
    // link that had stalled.
    it('shows sync progress on the link panel after the link completes', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);
      vi.spyOn(syncApi, 'syncAll').mockImplementation(async (_f, _ids, onProgress) => {
        onProgress?.('item-x', { phase: 'transactions', page: 1, fetched: 4321 });
        return new Promise(() => []) as never;
      });
      // A placeholder row, so the close handler finds an item to sync.
      await db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
        args: ['item-x', 'tok', 'Progress Bank'],
      });

      const r = accounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.emit('close', 0);
      await waitFor(() => expect(flatFrame(r)).toContain('Bank connected!'));
      // Still on the link panel — the sync step must be visible from here.
      await waitFor(() => expect(flatFrame(r)).toContain('Fetching transactions… 4,321 so far'));
    });

    it('still reports a bare exit code when the child said nothing on stderr', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.emit('close', 1);
      await waitFor(() => expect(flatFrame(r)).toContain('Process exited with code 1'));
    });
  });

  // The dupe scan runs detached from loadAccounts so it can't delay the
  // post-link sync. That means the Dupes view can be opened mid-scan, and it
  // must not report a clean result it doesn't have yet.
  describe('dupe scan in flight', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reports the scan as running instead of claiming no duplicates', async () => {
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates').mockImplementation(() => new Promise(() => {}));

      const r = accounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'dupes');
      await waitFor(() => expect(flatFrame(r)).toContain('Checking for duplicates…'));
      expect(flatFrame(r)).not.toContain('No duplicate candidates found.');
    });

    it('reports the clean result once the scan finishes', async () => {
      let finish: (v: never[]) => void = () => {};
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates')
        .mockImplementation(() => new Promise((res) => { finish = res as never; }));

      const r = accounts();
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
      const r = accounts();
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
      const r = accounts();
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
      const r = accounts();
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
      const r = accounts();
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
      const r = accounts();
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
        const r = accounts();
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

      const r = accounts();
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
      const r = accounts();
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
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(fmtBalanceAge({ days: 52, isStale: true } as never)).toBe('updated 52d ago');
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(true);
        expect(rowOf(r, 'CSV Savings')).not.toContain('synced');
      });

      it('a stale manual depository renders "updated 52d ago" in yellow', async () => {
        await seedManualAccount(db, { id: 'manual-cash', name: 'Cash Stash', balanceDaysAgo: 52 });
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(true);
        expect(rowOf(r, 'Cash Stash')).not.toContain('synced');
      });

      it('a manual "other" account at 52d is in the long tier: same text, not yellow', async () => {
        await seedManualAccount(db, { id: 'manual-house', name: 'House', type: 'other', subtype: null, balanceDaysAgo: 52 });
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 52d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 52d ago', SGR.yellow)).toBe(false);
        expect(rowOf(r, 'House')).not.toContain('synced');
      });

      it('a fresh balance (10d) is not yellow', async () => {
        await seedCsvAccount(db, { id: 'csv-fresh', name: 'Fresh CSV', balanceDaysAgo: 10 });
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 10d ago'));
        expect(frameHasColor(rawFrame(r), 'updated 10d ago', SGR.yellow)).toBe(false);
      });

      it('a balance from today renders "updated today"', async () => {
        await seedManualAccount(db, { id: 'manual-boat', name: 'Boat', type: 'other', subtype: null, balanceDaysAgo: 0 });
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated today'));
        expect(fmtBalanceAge({ days: 0, isStale: false } as never)).toBe('updated today');
      });

      it('a balance from yesterday renders "updated 1d ago"', async () => {
        await seedManualAccount(db, { id: 'manual-bike', name: 'Bike', type: 'other', subtype: null, balanceDaysAgo: 1 });
        const r = accounts();
        await waitFor(() => expect(flatFrame(r)).toContain('updated 1d ago'));
      });

      it('a Plaid-linked account shows "synced", never "updated"', async () => {
        await seedPlaidAccount(db, { id: 'acct-plaid-age', name: 'Plaid Chk', balanceDaysAgo: 52, lastSyncedAt: Date.now() - 5 * 60_000 });
        const r = accounts();
        await waitFor(() => expect(rowOf(r, 'Plaid Chk')).toContain('synced'));
        expect(flatFrame(r)).not.toContain('updated');
      });
    });
  });

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

      const r = accounts();
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

      const r = accounts();
      await tabTo(r, 'links');
      // days_requested is NULL here, which means Plaid's 90-day default applied.
      expect(flatFrame(r)).toContain('90d (default)');
    });

    it('flags a connection awaiting its first sync', async () => {
      await addItem('item-new', 'Capital One', null);

      const r = accounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('awaiting first sync');
    });

    it('flags a connection with no stored cursor', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('sync cursor cleared');
    });

    it('drops the flag once a cursor is stored', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: ['item-a', 'cur'] });

      const r = accounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).not.toContain('sync cursor cleared');
    });

    // Pressing [u] spawns the Plaid subprocess, so the behaviour it drives is
    // covered in tests/tui/accounts-update-link.test.tsx, which mocks the spawn.
    it('offers [u] update link on a connection row', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('[u] update link');
    });

    it('empty state points at Add Data', async () => {
      const r = accounts();
      await tabTo(r, 'links');
      expect(flatFrame(r)).toContain('No bank connections yet.');
    });

    it('the link action is no longer offered from an account row', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts({ showHints: true });
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
        const r = accounts();
        await tabTo(r, 'links');
        expect(flatFrame(r)).toContain('[r] refresh');
      });

      it('asks for confirmation and says Plaid charges before doing anything', async () => {
        await linksWithItem();
        const spy = vi.spyOn(refreshApi, 'refreshTransactions');

        const r = accounts();
        await tabTo(r, 'links');
        r.stdin.write('r');

        await waitFor(() => expect(flatFrame(r)).toContain('Plaid charges for each refresh'));
        // Item-scoped, and the panel says so rather than implying one account.
        expect(flatFrame(r)).toContain('all 2 accounts on this connection');
        expect(spy).not.toHaveBeenCalled();
      });

      it('names the connection history window it cannot reach past', async () => {
        await linksWithItem(730);
        const r = accounts();
        await tabTo(r, 'links');
        r.stdin.write('r');

        await waitFor(() => expect(flatFrame(r)).toContain('730-day history window'));
      });

      it('[n] backs out without spending a refresh', async () => {
        await linksWithItem();
        const spy = vi.spyOn(refreshApi, 'refreshTransactions');

        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
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
        const r = accounts();
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

        const r = accounts();
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
        const r = accounts();
        await tabTo(r, 'links');
        expect(flatFrame(r)).toContain('[d] delete sync cursor');
      });

      it('asks for confirmation before deleting anything', async () => {
        await linksWithSyncedItem();
        const spy = vi.spyOn(syncApi, 'deleteSyncCursor');

        const r = accounts();
        await tabTo(r, 'links');
        r.stdin.write('d');

        await waitFor(() => expect(flatFrame(r)).toContain('Delete sync cursor and resync'));
        // Item-scoped, and the panel says so rather than implying one account.
        expect(flatFrame(r)).toContain('all 2 accounts on this connection');
        expect(spy).not.toHaveBeenCalled();
      });

      it('warns that hand-deleted transactions come back, and that Plaid gaps stay', async () => {
        await linksWithSyncedItem();
        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
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

        const r = accounts();
        await tabTo(r, 'links');
        await waitFor(() => expect(flatFrame(r)).toContain('connection'));
        expect(flatFrame(r)).not.toContain('Encryption key');
      });

      it('flags a missing key file with the affected account count', async () => {
        vi.spyOn(keyHealthApi, 'checkKeyHealth').mockResolvedValue({
          ok: false, reason: 'missing_key', linkedAccountCount: 2,
        });

        const r = accounts();
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

        const r = accounts();
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
