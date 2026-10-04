import { describe, it, expect, beforeEach, vi } from 'vitest';
import { seedPlaidItem } from '../../helpers/seedDb.js';

// DATA SAFETY: registry imports core/db.js, which would open the real ~/.fungible DB.
vi.mock('../../../core/db.js', async () => ({
  db: await (await import('../../helpers/makeTestDb.js')).makeTestDb(),
}));
vi.mock('../../../core/sync.js', async (orig) => ({
  ...(await orig<typeof import('../../../core/sync.js')>()),
  syncAll: vi.fn(),
  deleteSyncCursor: vi.fn(),
}));

import { db } from '../../../core/db.js';
import { syncAll, deleteSyncCursor } from '../../../core/sync.js';
import { clearSyncFailures, getSyncFailures, setSyncResult } from '../../../core/sync-status.js';
import { onSyncProgress } from '../../../gui/main/sync-progress.js';
import { registry } from '../../../gui/main/registry.js';

const sync = registry.sync;
const syncAllMock = vi.mocked(syncAll);
const deleteCursor = vi.mocked(deleteSyncCursor);
const res = (itemId: string, error?: string) =>
  ({ itemId, added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, ...(error ? { error } : {}) }) as any;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  syncAllMock.mockReset();
  deleteCursor.mockReset();
  deleteCursor.mockResolvedValue(undefined as any);
  clearSyncFailures();
  await db.execute('DELETE FROM plaid_items');
});

describe('sync.syncAll status recording', () => {
  it('whole-DB clean run clears every failure', async () => {
    setSyncResult([res('i2', 'old')]);
    syncAllMock.mockResolvedValue([res('i1'), res('i2')]);
    await sync.syncAll();
    expect(await sync.getStatus()).toEqual([]);
  });

  it('whole-DB run records errored items as itemId + error', async () => {
    syncAllMock.mockResolvedValue([res('i1', 'login required'), res('i2')]);
    await sync.syncAll();
    expect(await sync.getStatus()).toEqual([{ itemId: 'i1', error: 'login required' }]);
  });

  it('an empty itemIds array is a whole-DB sync (replaces everything)', async () => {
    setSyncResult([res('i2', 'old')]);
    syncAllMock.mockResolvedValue([res('i1')]);
    await sync.syncAll(false, []);
    expect(getSyncFailures()).toEqual([]);
  });

  it('scoped run keeps other items\' failures and replaces the attempted one', async () => {
    setSyncResult([res('i1', 'old1'), res('i2', 'old2')]);
    syncAllMock.mockResolvedValue([res('i1', 'new1')]);
    await sync.syncAll(false, ['i1']);
    expect(getSyncFailures()).toEqual([
      { itemId: 'i2', error: 'old2' },
      { itemId: 'i1', error: 'new1' },
    ]);
  });

  it('scoped clean run clears only the attempted item', async () => {
    setSyncResult([res('i1', 'old1'), res('i2', 'old2')]);
    syncAllMock.mockResolvedValue([res('i1')]);
    await sync.syncAll(true, ['i1']);
    expect(getSyncFailures()).toEqual([{ itemId: 'i2', error: 'old2' }]);
  });

  it('passes force and itemIds through and returns the results', async () => {
    const results = [res('i1')];
    syncAllMock.mockResolvedValue(results);
    expect(await sync.syncAll(true, ['i1'])).toBe(results);
    expect(syncAllMock).toHaveBeenCalledWith(true, ['i1']);
  });

  it('a rejecting syncAll propagates and leaves existing failures untouched', async () => {
    setSyncResult([res('i2', 'old')]);
    syncAllMock.mockRejectedValue(new Error('network'));
    await expect(sync.syncAll()).rejects.toThrow('network');
    expect(getSyncFailures()).toEqual([{ itemId: 'i2', error: 'old' }]);
  });

  it('getStatus is empty initially', async () => {
    expect(await sync.getStatus()).toEqual([]);
  });
});

describe('sync.isSyncing', () => {
  it('is true while syncAll is pending and false after it resolves', async () => {
    const d = deferred<any[]>();
    syncAllMock.mockReturnValue(d.promise);
    const p = sync.syncAll();
    expect(await sync.isSyncing()).toBe(true);
    d.resolve([]);
    await p;
    expect(await sync.isSyncing()).toBe(false);
  });

  it('is false after a rejection, which still propagates', async () => {
    syncAllMock.mockRejectedValue(new Error('boom'));
    await expect(sync.syncAll()).rejects.toThrow('boom');
    expect(await sync.isSyncing()).toBe(false);
  });

  it('stays true until the last of two concurrent syncs finishes, with one on / one off push', async () => {
    const events: boolean[] = [];
    const off = onSyncProgress((s) => events.push(s));
    const a = deferred<any[]>();
    const b = deferred<any[]>();
    syncAllMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pa = sync.syncAll();
    const pb = sync.syncAll();
    a.resolve([]);
    await pa;
    expect(await sync.isSyncing()).toBe(true);
    b.resolve([]);
    await pb;
    expect(await sync.isSyncing()).toBe(false);
    expect(events).toEqual([true, false]);
    off();
  });
});

describe('sync.deleteCursorAndResync', () => {
  it('deletes the cursor BEFORE a forced scoped resync and returns the first result', async () => {
    const log: string[] = [];
    deleteCursor.mockImplementation(async () => { log.push('delete'); });
    syncAllMock.mockImplementation(async () => { log.push('sync'); return [res('i1')]; });
    const out = await sync.deleteCursorAndResync('i1');
    expect(log).toEqual(['delete', 'sync']);
    expect(deleteCursor).toHaveBeenCalledWith('i1');
    expect(syncAllMock).toHaveBeenCalledWith(true, ['i1']);
    expect(out).toEqual(res('i1'));
  });

  it('merges only the resynced item\'s status', async () => {
    setSyncResult([res('i1', 'old1'), res('i2', 'old2')]);
    syncAllMock.mockResolvedValue([res('i1', 'still bad')]);
    await sync.deleteCursorAndResync('i1');
    expect(getSyncFailures()).toEqual([
      { itemId: 'i2', error: 'old2' },
      { itemId: 'i1', error: 'still bad' },
    ]);
  });

  it('a failing cursor delete skips the sync, propagates, and ends progress', async () => {
    deleteCursor.mockRejectedValue(new Error('db locked'));
    await expect(sync.deleteCursorAndResync('i1')).rejects.toThrow('db locked');
    expect(syncAllMock).not.toHaveBeenCalled();
    expect(await sync.isSyncing()).toBe(false);
  });

  // Smell: for an unknown item syncAll returns [], so this resolves undefined
  // (no error surfaced) and mergeSyncResult silently clears any failure badge for it.
  it('unknown item -> undefined and clears a stale failure for that id (current behaviour)', async () => {
    setSyncResult([res('ghost', 'stale')]);
    syncAllMock.mockResolvedValue([]);
    expect(await sync.deleteCursorAndResync('ghost')).toBeUndefined();
    expect(getSyncFailures()).toEqual([]);
  });
});

describe('sync.getLastSyncedAt', () => {
  it('is null with no items', async () => {
    expect(await sync.getLastSyncedAt()).toBeNull();
  });

  it('is the MAX across items, as a number', async () => {
    await seedPlaidItem(db, 'a', { lastSyncedAt: 1_700_000_000_000 });
    await seedPlaidItem(db, 'b', { lastSyncedAt: 1_800_000_000_000 });
    await seedPlaidItem(db, 'c', { lastSyncedAt: null });
    expect(await sync.getLastSyncedAt()).toBe(1_800_000_000_000);
  });
});
