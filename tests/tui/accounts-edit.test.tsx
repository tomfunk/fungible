import { describe, it, expect, afterEach, vi } from 'vitest';

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
import * as accountsApi from '../../core/accounts.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAccounts } from './helpers/accountsScreen.js';
import { loadProfile } from '../../core/profile.js';

useSeededScreenDb();

const ownerOf = async (id: string) =>
  (await db.execute({ sql: 'SELECT owner FROM accounts WHERE id = ?', args: [id] })).rows[0].owner;

describe('Accounts', () => {
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

    const r = renderAccounts();
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

    const r = renderAccounts();
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

    const r = renderAccounts();
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

    const r = renderAccounts();
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

    const r = renderAccounts();
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
    // And the value really persisted, not just painted. The row text can still
    // come from the open edit panel while the (delayed) write is in flight, so poll.
    await waitFor(async () => expect(await ownerOf('test-checking')).toBe('Alex Stark'));
  });

  it('surfaces an error and does not apply the owner when the write fails', async () => {
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Alex Stark', birthYear: 0 }, children: [] });
    vi.spyOn(accountsApi, 'updateAccountOwner').mockRejectedValue(new Error('db down'));

    const r = renderAccounts();
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
    expect(await ownerOf('test-checking')).toBeNull();
  });
});
