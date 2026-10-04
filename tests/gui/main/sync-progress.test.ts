import { describe, it, expect, beforeEach, vi } from 'vitest';

// Module-level counter: re-import a fresh module per test.
type Mod = typeof import('../../../gui/main/sync-progress.js');
let m: Mod;
beforeEach(async () => {
  vi.resetModules();
  m = await import('../../../gui/main/sync-progress.js');
});

describe('sync-progress counter', () => {
  it('stays in progress until every start has a matching end', () => {
    m.syncProgressStart();
    m.syncProgressStart();
    m.syncProgressEnd();
    expect(m.isSyncInProgress()).toBe(true);
    m.syncProgressEnd();
    expect(m.isSyncInProgress()).toBe(false);
  });

  it('notifies only on the 0->1 and 1->0 transitions', () => {
    const calls: boolean[] = [];
    m.onSyncProgress((s) => calls.push(s));
    m.syncProgressStart();
    m.syncProgressStart();
    m.syncProgressEnd();
    m.syncProgressEnd();
    expect(calls).toEqual([true, false]);
  });

  it('an end with no start does not go negative', () => {
    const calls: boolean[] = [];
    m.onSyncProgress((s) => calls.push(s));
    m.syncProgressEnd(); // clamped at 0; still emits idle (pins current behaviour)
    calls.length = 0;
    m.syncProgressStart();
    expect(m.isSyncInProgress()).toBe(true);
    expect(calls).toEqual([true]);
    m.syncProgressEnd();
    expect(m.isSyncInProgress()).toBe(false);
  });

  it('unsubscribe stops notifications', () => {
    const calls: boolean[] = [];
    const off = m.onSyncProgress((s) => calls.push(s));
    off();
    m.syncProgressStart();
    m.syncProgressEnd();
    expect(calls).toEqual([]);
  });
});

describe('withSyncProgress', () => {
  it('returns the value and counts the call for its whole duration', async () => {
    let release!: () => void;
    const p = m.withSyncProgress(() => new Promise<number>((r) => (release = () => r(42))));
    expect(m.isSyncInProgress()).toBe(true);
    release();
    expect(await p).toBe(42);
    expect(m.isSyncInProgress()).toBe(false);
  });

  it('rethrows a rejection and still ends', async () => {
    const calls: boolean[] = [];
    m.onSyncProgress((s) => calls.push(s));
    await expect(m.withSyncProgress(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(m.isSyncInProgress()).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it('ends even when fn throws synchronously', async () => {
    await expect(m.withSyncProgress((() => { throw new Error('sync'); }) as any)).rejects.toThrow('sync');
    expect(m.isSyncInProgress()).toBe(false);
  });
});
