// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { deferred } from '../helpers/deferred.js';
import { useSync } from '../../gui/renderer/src/hooks/useSync.js';
import { installBridge, Providers, renderScreen, type BridgeHarness } from './helpers/renderGui.js';
import { Transactions } from '../../gui/renderer/src/screens/Transactions.js';
import { registry } from '../../gui/main/registry.js';

type SyncResults = Awaited<ReturnType<typeof registry.sync.syncAll>>;
const res = (...rs: Partial<SyncResults[number]>[]) => rs as SyncResults;

let bridge: BridgeHarness;
let syncAll: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'transactions', 'accounts', 'categories', 'tags', 'balance_history']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  bridge = installBridge();
  // Never let the real Plaid sync run.
  syncAll = vi.spyOn(registry.sync, 'syncAll');
  syncAll.mockResolvedValue(res({ added: 0 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const syncBtn = () => screen.getByRole('button', { name: /Sync/ }) as HTMLButtonElement;
const ready = () => screen.findByRole('button', { name: '⟳ Sync' });

describe('FilterBar sync control', () => {
  it('forces a sync and toasts the total added (plural)', async () => {
    syncAll.mockResolvedValue(res({ added: 1 }, { added: 2 }));
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    expect(await screen.findByText('Sync done — 3 new transactions')).toBeTruthy();
    expect(syncAll).toHaveBeenCalledTimes(1);
    expect(syncAll).toHaveBeenCalledWith(true);
  });

  it('singular when exactly one transaction was added', async () => {
    syncAll.mockResolvedValue(res({ added: 1 }));
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    expect(await screen.findByText('Sync done — 1 new transaction')).toBeTruthy();
  });

  it('zero added is plural', async () => {
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    expect(await screen.findByText('Sync done — 0 new transactions')).toBeTruthy();
  });

  it('reports per-item errors joined, and re-enables the button', async () => {
    syncAll.mockResolvedValue(res({ added: 0, error: 'e1' }, { added: 5, error: 'e2' }, { added: 1 }));
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    // default text matcher collapses whitespace; assert the raw double-space text
    const toast = await screen.findByText((_c, el) => el?.textContent?.startsWith('Sync failed: e1') === true && el.children.length === 0);
    expect(toast.textContent).toBe('Sync failed: e1  ·  e2');
    expect(syncBtn().disabled).toBe(false);
    expect(syncBtn().textContent).toBe('⟳ Sync');
  });

  it('a rejected sync shows "Sync failed" and re-enables the button', async () => {
    syncAll.mockRejectedValue(new Error('network'));
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    expect(await screen.findByText('Sync failed')).toBeTruthy();
    expect(syncBtn().disabled).toBe(false);
  });

  it('shows Syncing… disabled while in flight, ignores a second click, then restores', async () => {
    const d = deferred<SyncResults>();
    syncAll.mockImplementation(() => d.promise);
    renderScreen(<div />, { filterBar: true });
    await userEvent.click(await ready());
    await waitFor(() => expect(syncBtn().textContent).toBe('Syncing…'));
    expect(syncBtn().disabled).toBe(true);
    await userEvent.click(syncBtn());
    expect(syncAll).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(res({ added: 2 })));
    await waitFor(() => expect(syncBtn().textContent).toBe('⟳ Sync'));
    expect(syncBtn().disabled).toBe(false);
    expect(syncAll).toHaveBeenCalledTimes(1);
  });

  it('global sync-progress push shows Syncing… without a click, and false restores', async () => {
    renderScreen(<div />, { filterBar: true });
    await ready();
    act(() => bridge.emit('sync-progress', true));
    await waitFor(() => expect(syncBtn().textContent).toBe('Syncing…'));
    expect(syncBtn().disabled).toBe(true);
    act(() => bridge.emit('sync-progress', false));
    await waitFor(() => expect(syncBtn().textContent).toBe('⟳ Sync'));
    expect(syncBtn().disabled).toBe(false);
  });

  it('a click while a global sync runs does not start another', async () => {
    renderScreen(<div />, { filterBar: true });
    await ready();
    act(() => bridge.emit('sync-progress', true));
    await waitFor(() => expect(syncBtn().disabled).toBe(true));
    await userEvent.click(syncBtn());
    expect(syncAll).not.toHaveBeenCalled();
  });

  it.each([
    ['success', (d: ReturnType<typeof deferred<SyncResults>>) => d.resolve(res({ added: 1 }))],
    ['failure', (d: ReturnType<typeof deferred<SyncResults>>) => d.reject(new Error('x'))],
  ])('a mounted screen refetches after a sync (%s) without remount', async (_n, settle) => {
    const d = deferred<SyncResults>();
    syncAll.mockImplementation(() => d.promise);
    renderScreen(<Transactions />, { filterBar: true });
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(await ready());
    await waitFor(() => expect(syncBtn().textContent).toBe('Syncing…'));
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-new', 'test-credit', '2026-05-20', 'Brand New Cafe', 12.00, 'Dining', 0, 0)`,
    );
    expect(screen.queryByText('Brand New Cafe')).toBeNull();
    await act(async () => settle(d));
    expect(await screen.findByText('Brand New Cafe')).toBeTruthy();
    expect(screen.getByText('10 transactions')).toBeTruthy();
  });

  it('shows "synced N min ago" when known, hidden while syncing', async () => {
    vi.spyOn(registry.sync, 'getLastSyncedAt').mockResolvedValue(Date.now() - 10 * 60_000);
    renderScreen(<div />, { filterBar: true });
    expect(await screen.findByText('synced 10 min ago')).toBeTruthy();
    act(() => bridge.emit('sync-progress', true));
    await waitFor(() => expect(screen.queryByText('synced 10 min ago')).toBeNull());
    act(() => bridge.emit('sync-progress', false));
    expect(await screen.findByText('synced 10 min ago')).toBeTruthy();
  });

  it('shows "synced never" when nothing has synced', async () => {
    vi.spyOn(registry.sync, 'getLastSyncedAt').mockResolvedValue(null);
    renderScreen(<div />, { filterBar: true });
    expect(await screen.findByText('synced never')).toBeTruthy();
  });
});

describe('useSync guard (hook level)', () => {
  it('a forceSync while one is in flight is a no-op returning undefined', async () => {
    const d = deferred<SyncResults>();
    syncAll.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useSync(), { wrapper: ({ children }) => <Providers>{children}</Providers> });
    let first!: Promise<unknown>;
    act(() => { first = result.current.forceSync(); });
    await waitFor(() => expect(result.current.syncing).toBe(true));
    let second: unknown = 'unset';
    await act(async () => { second = await result.current.forceSync(); });
    expect(second).toBeUndefined();
    expect(syncAll).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(res({ added: 1 })); await first; });
  });
});
