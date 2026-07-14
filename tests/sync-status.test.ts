import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setSyncResult, getSyncFailures, clearSyncFailures, onSyncStatus } from '../core/sync-status.js';
import type { SyncItemResult } from '../core/sync.js';

const ok = (itemId: string): SyncItemResult => ({ itemId, added: 0, modified: 0, removed: 0, dupes: 0, skipped: false });
const fail = (itemId: string, error: string): SyncItemResult => ({ ...ok(itemId), error });

beforeEach(() => clearSyncFailures());

describe('sync-status store', () => {
  it('keeps only the failed items', () => {
    setSyncResult([ok('a'), fail('b', 'ITEM_LOGIN_REQUIRED')]);
    expect(getSyncFailures()).toEqual([{ itemId: 'b', error: 'ITEM_LOGIN_REQUIRED' }]);
  });

  it('a clean run clears prior failures', () => {
    setSyncResult([fail('b', 'x')]);
    setSyncResult([ok('a')]);
    expect(getSyncFailures()).toEqual([]);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = onSyncStatus(fn);
    setSyncResult([fail('b', 'x')]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setSyncResult([fail('c', 'y')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clearSyncFailures empties, and is a no-op (no emit) when already empty', () => {
    setSyncResult([fail('b', 'x')]);
    const fn = vi.fn();
    const off = onSyncStatus(fn);
    clearSyncFailures();
    expect(getSyncFailures()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    clearSyncFailures();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});
