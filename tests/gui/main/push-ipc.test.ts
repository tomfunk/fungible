import { electronMock, makeWindow } from '../../helpers/makeElectronMock.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());

// Prime the electron mock once, before any resetModules: vitest caches the
// factory result, and it must bind to the same helper instance this file uses.
await import('electron');

beforeEach(() => {
  electronMock.reset();
  // Fresh emitters/counters: the push registrars have no unsubscribe.
  vi.resetModules();
});

describe('refresh push', () => {
  it('sends "refresh" to every window', async () => {
    const { registerRefreshPush } = await import('../../../gui/main/refresh-ipc.js');
    const { notifyChange } = await import('../../../core/refresh.js');
    registerRefreshPush();
    const a = makeWindow();
    const b = makeWindow();
    notifyChange();
    expect(a.webContents.send).toHaveBeenCalledExactlyOnceWith('refresh');
    expect(b.webContents.send).toHaveBeenCalledExactlyOnceWith('refresh');
  });

  it('is a no-op with zero windows', async () => {
    const { registerRefreshPush } = await import('../../../gui/main/refresh-ipc.js');
    const { notifyChange } = await import('../../../core/refresh.js');
    registerRefreshPush();
    expect(() => notifyChange()).not.toThrow();
  });
});

describe('sync-status push', () => {
  it('pushes the current failures (itemId + error only) to every window, then [] when cleared', async () => {
    const { registerSyncStatusPush } = await import('../../../gui/main/sync-status-ipc.js');
    const { setSyncResult } = await import('../../../core/sync-status.js');
    registerSyncStatusPush();
    const a = makeWindow();
    const b = makeWindow();
    setSyncResult([
      { itemId: 'i1', error: 'boom', added: 3 } as any,
      { itemId: 'i2' } as any, // success: not a failure
    ]);
    for (const w of [a, b]) {
      expect(w.webContents.send).toHaveBeenLastCalledWith('sync-status', [{ itemId: 'i1', error: 'boom' }]);
    }
    setSyncResult([]);
    for (const w of [a, b]) {
      expect(w.webContents.send).toHaveBeenCalledTimes(2);
      expect(w.webContents.send).toHaveBeenLastCalledWith('sync-status', []);
    }
  });

  it('is a no-op with zero windows', async () => {
    const { registerSyncStatusPush } = await import('../../../gui/main/sync-status-ipc.js');
    const { setSyncResult } = await import('../../../core/sync-status.js');
    registerSyncStatusPush();
    expect(() => setSyncResult([])).not.toThrow();
  });
});

describe('sync-progress push', () => {
  it('pushes true on start and false on end to every window', async () => {
    const { registerSyncProgressPush } = await import('../../../gui/main/sync-progress-ipc.js');
    const { syncProgressStart, syncProgressEnd } = await import('../../../gui/main/sync-progress.js');
    registerSyncProgressPush();
    const a = makeWindow();
    const b = makeWindow();
    syncProgressStart();
    for (const w of [a, b]) expect(w.webContents.send).toHaveBeenLastCalledWith('sync-progress', true);
    syncProgressEnd();
    for (const w of [a, b]) {
      expect(w.webContents.send.mock.calls).toEqual([['sync-progress', true], ['sync-progress', false]]);
    }
  });

  it('nested start/start/end pushes only the initial true', async () => {
    const { registerSyncProgressPush } = await import('../../../gui/main/sync-progress-ipc.js');
    const { syncProgressStart, syncProgressEnd } = await import('../../../gui/main/sync-progress.js');
    registerSyncProgressPush();
    const w = makeWindow();
    syncProgressStart();
    syncProgressStart();
    syncProgressEnd();
    expect(w.webContents.send.mock.calls).toEqual([['sync-progress', true]]);
  });
});
