import { describe, it, expect, beforeEach, vi } from 'vitest';
import { electronMock, makeEvent } from '../../helpers/makeElectronMock.js';

vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());
vi.mock('../../../core/transactions-refresh.js', () => ({ refreshTransactions: vi.fn() }));

import { refreshTransactions } from '../../../core/transactions-refresh.js';
import { getSyncFailures, setSyncResult, clearSyncFailures } from '../../../core/sync-status.js';
import { registerSyncIpc } from '../../../gui/main/sync-ipc.js';

const refresh = vi.mocked(refreshTransactions);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const ok = (syncResults: any[] = []) => ({ syncResults }) as any;

beforeEach(() => {
  electronMock.reset();
  refresh.mockReset();
  clearSyncFailures();
  registerSyncIpc();
});

describe('sync:refresh wiring', () => {
  it('registers exactly the refresh and cancel channels', () => {
    expect([...electronMock.handlers.keys()].sort()).toEqual(['sync:refresh', 'sync:refresh-cancel']);
  });

  it('returns the refreshTransactions result unchanged and passes the itemId', async () => {
    const result = ok();
    refresh.mockResolvedValue(result);
    expect(await electronMock.invoke('sync:refresh', 'i1')).toBe(result);
    expect(refresh.mock.calls[0][0]).toBe('i1');
  });

  it('forwards progress to the sender; nothing after the sender is destroyed', async () => {
    const ev = makeEvent();
    refresh.mockImplementation(async (_id, opts: any) => {
      opts.onProgress({ step: 1 });
      ev.sender.destroyed = true;
      expect(() => opts.onProgress({ step: 2 })).not.toThrow();
      return ok();
    });
    await electronMock.invokeWith(ev, 'sync:refresh', 'i1');
    expect(ev.sender.send.mock.calls).toEqual([['sync:refresh-progress', { step: 1 }]]);
  });
});

describe('sync:refresh status recording', () => {
  it('merges results scoped to the item, keeping another item\'s failure', async () => {
    setSyncResult([{ itemId: 'other', error: 'stale' } as any]);
    refresh.mockResolvedValue(ok([{ itemId: 'i1', error: 'bad' }]));
    await electronMock.invoke('sync:refresh', 'i1');
    expect(getSyncFailures()).toEqual([
      { itemId: 'other', error: 'stale' },
      { itemId: 'i1', error: 'bad' },
    ]);
  });

  it('a clean check clears that item\'s stale failure only', async () => {
    setSyncResult([{ itemId: 'i1', error: 'old' }, { itemId: 'other', error: 'stale' }] as any);
    refresh.mockResolvedValue(ok([{ itemId: 'i1' }]));
    await electronMock.invoke('sync:refresh', 'i1');
    expect(getSyncFailures()).toEqual([{ itemId: 'other', error: 'stale' }]);
  });

  it('empty syncResults leaves status untouched', async () => {
    setSyncResult([{ itemId: 'i1', error: 'old' }] as any);
    refresh.mockResolvedValue(ok([]));
    await electronMock.invoke('sync:refresh', 'i1');
    expect(getSyncFailures()).toEqual([{ itemId: 'i1', error: 'old' }]);
  });

  it('a rejection propagates, leaves status alone, and does not wedge the next call', async () => {
    setSyncResult([{ itemId: 'i1', error: 'old' }] as any);
    refresh.mockRejectedValueOnce(new Error('plaid down'));
    await expect(electronMock.invoke('sync:refresh', 'i1')).rejects.toThrow('plaid down');
    expect(getSyncFailures()).toEqual([{ itemId: 'i1', error: 'old' }]);

    let signal: AbortSignal | undefined;
    refresh.mockImplementationOnce(async (_id, opts: any) => { signal = opts.signal; return ok(); });
    await electronMock.invoke('sync:refresh', 'i1');
    expect(signal?.aborted).toBe(false);
  });
});

describe('sync:refresh concurrency', () => {
  function pending() {
    const d = deferred<any>();
    const signals: AbortSignal[] = [];
    refresh.mockImplementation((_id, opts: any) => { signals.push(opts.signal); return d.promise; });
    return { d, signals };
  }

  it('a second call for the same item aborts the first, not itself', async () => {
    const { d, signals } = pending();
    const p1 = electronMock.invoke('sync:refresh', 'i1');
    const p2 = electronMock.invoke('sync:refresh', 'i1');
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    d.resolve(ok());
    await Promise.all([p1, p2]);
  });

  it('cancel still aborts the replacement after the replaced call settles', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const signals: AbortSignal[] = [];
    refresh
      .mockImplementationOnce((_id, o: any) => { signals.push(o.signal); return first.promise; })
      .mockImplementationOnce((_id, o: any) => { signals.push(o.signal); return second.promise; });
    const p1 = electronMock.invoke('sync:refresh', 'i1');
    const p2 = electronMock.invoke('sync:refresh', 'i1');
    first.resolve(ok());
    await p1;
    await electronMock.invoke('sync:refresh-cancel', 'i1');
    expect(signals[1].aborted).toBe(true);
    second.resolve(ok());
    await p2;
  });

  it('a different item is not aborted', async () => {
    const { d, signals } = pending();
    const p1 = electronMock.invoke('sync:refresh', 'i1');
    const p2 = electronMock.invoke('sync:refresh', 'i2');
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    await electronMock.invoke('sync:refresh-cancel', 'i2');
    expect(signals.map((s) => s.aborted)).toEqual([false, true]);
    d.resolve(ok());
    await Promise.all([p1, p2]);
  });

  it('cancel after completion or for an unknown item resolves undefined', async () => {
    expect(await electronMock.invoke('sync:refresh-cancel', 'nope')).toBeUndefined();
    refresh.mockResolvedValue(ok());
    await electronMock.invoke('sync:refresh', 'i1');
    expect(await electronMock.invoke('sync:refresh-cancel', 'i1')).toBeUndefined();
  });

  // Smell: the comment in sync-ipc.ts says a cancel path exists for "a window
  // close", but nothing aborts inflight polls when a window closes.
  it.todo('aborts in-flight polls when the window closes');
});
