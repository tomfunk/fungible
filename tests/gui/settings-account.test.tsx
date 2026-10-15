// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Real sync engine + real gui/main/account-sync.ts against a file DB and the
// in-memory protocol server (tests/sync/fakeServer.ts). Only the network edge
// and the snapshot file write are faked.
vi.mock('../../core/paths.js', async () => ({
  DATA_DIR: (await import('../helpers/tempDataDir.js')).tempDataDir.dir,
}));
const holder = vi.hoisted(() => ({
  client: null as unknown as import('@libsql/client').Client,
  snapshots: 0,
  failSnapshot: false,
}));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const v = (holder.client as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(holder.client) : v;
    },
  }),
}));
vi.mock('../../core/snapshot.js', () => ({
  snapshot: vi.fn(async () => {
    if (holder.failSnapshot) throw new Error('disk full');
    holder.snapshots++;
  }),
}));

import { tempDataDir } from '../helpers/tempDataDir.js';
import { makeDevice, type Device } from '../sync/harness.js';
import { FakeServer, fakeJwt } from '../sync/fakeServer.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Settings } from '../../gui/renderer/src/screens/Settings.js';
import { account } from '../../gui/main/account-sync.js';
import { configureAuth, memoryAuthAdapter } from '../../core/auth-client.js';
import { configureSync, stopBackgroundSync } from '../../core/sync-client.js';

const BASE = 'http://sync.test';
let userId = 'user-1';
let server: FakeServer;
let device: Device;

type Bridge = { platform?: string; call: (ns: string, fn: string, a: unknown[]) => Promise<unknown> };
const bridge = () => (window as unknown as { __bridge: Bridge }).__bridge;

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/login') || u.endsWith('/auth/register')) {
      return new Response(JSON.stringify({ accessToken: fakeJwt(userId, 'me@example.test'), refreshToken: 'r' }), { status: 200 });
    }
    return server.fetch(url, init);
  }));
}

function bridgeAccountTo(real: typeof account) {
  const b = bridge();
  const prev = b.call;
  b.call = async (ns, fn, args) => {
    if (ns === 'account' && fn in real) {
      return (real as unknown as Record<string, (...a: unknown[]) => unknown>)[fn](...args);
    }
    return prev(ns, fn, args);
  };
}

async function fillAndConnect(label: string) {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('Email'));
  await user.type(screen.getByLabelText('Email'), 'me@example.test');
  await user.type(screen.getByLabelText('Password'), 'password1');
  await user.click(screen.getByRole('button', { name: label }));
}

beforeEach(async () => {
  tempDataDir.reset();
  device = await makeDevice('fungible-gui-account-');
  holder.client = device.client;
  holder.snapshots = 0;
  holder.failSnapshot = false;
  userId = 'user-1';
  server = new FakeServer();
  installBridge();
  stubFetch();
});
afterEach(() => { cleanup(); stopBackgroundSync(); vi.unstubAllGlobals(); device.close(); });
afterAll(() => tempDataDir.cleanup());

describe('Settings account panel on desktop', () => {
  it('without FUNGIBLE_SYNC_URL (state null) renders no Account section and keeps Configuration/Backup', async () => {
    // The module-level engine is unconfigured until a test configures it, and
    // this runs first, so the real getSyncState answers null.
    bridgeAccountTo(account);
    renderScreen(<Settings />);
    await waitFor(() => expect(screen.getByText('Configuration')).toBeTruthy());
    expect(screen.queryByText('Account')).toBeNull();
    expect(screen.queryByText('Local only')).toBeNull();
    expect(screen.getByText('Backup')).toBeTruthy();
  });

  describe('when configured', () => {
    beforeEach(() => {
      configureAuth(memoryAuthAdapter(), BASE, { fetch: (u, i) => globalThis.fetch(u, i) });
      configureSync(BASE, { fetch: (u, i) => globalThis.fetch(u, i) });
      bridgeAccountTo(account);
    });

    it('shows the one-line disclosure, connects, shows account and counts, and takes its own safety snapshot', async () => {
      renderScreen(<Settings />);
      await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());
      expect(screen.getByText('Syncing sends your data to your account on the server.')).toBeTruthy();
      await fillAndConnect('Connect (log in)');
      await waitFor(() => expect(screen.getByText('Synced via account: me@example.test')).toBeTruthy());
      expect(screen.getByText(/Connected\. Synced: \d+ pulled, \d+ pushed/)).toBeTruthy();
      expect(screen.getByText('Last sync')).toBeTruthy();
      expect(screen.getByText('Pending changes')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
      expect(screen.getByText('Configuration')).toBeTruthy(); // desktop keeps its local panels
      expect(holder.snapshots).toBeGreaterThanOrEqual(1);
    });

    it('a failed safety snapshot is shown as such and leaves sync off and the database untouched', async () => {
      holder.failSnapshot = true;
      renderScreen(<Settings />);
      await waitFor(() => screen.getByText('Local only'));
      await fillAndConnect('Connect (log in)');
      await waitFor(() => expect(screen.getByText(/Could not take a safety backup, so sync was not enabled/)).toBeTruthy());
      expect(screen.getByText('Local only')).toBeTruthy();
      const tables = await device.client.execute("SELECT name FROM sqlite_master WHERE name = '_oplog'");
      expect(tables.rows).toHaveLength(0);
    });

    it('Sync now pushes local edits; Disconnect returns to local and keeps data', async () => {
      renderScreen(<Settings />);
      await waitFor(() => screen.getByText('Local only'));
      await device.client.execute(`INSERT INTO tags (name) VALUES ('keepme')`);
      await fillAndConnect('Connect (log in)');
      const user = userEvent.setup();
      await waitFor(() => screen.getByRole('button', { name: 'Sync now' }));
      await user.click(screen.getByRole('button', { name: 'Sync now' }));
      await waitFor(() => expect(screen.getByText(/^Synced: /)).toBeTruthy());
      expect(server.liveRows('user-1', 'tags').map((t) => t.name)).toContain('keepme');

      await user.click(screen.getByRole('button', { name: 'Disconnect (data stays local)' }));
      await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());
      const tags = await device.client.execute('SELECT name FROM tags');
      expect(tags.rows.map((r) => r.name)).toContain('keepme');
    });

    it('asks for an explicit reset when this database last synced as another account', async () => {
      renderScreen(<Settings />);
      await waitFor(() => screen.getByText('Local only'));
      await device.client.execute(`INSERT INTO tags (name) VALUES ('mine')`);
      await fillAndConnect('Connect (log in)');
      const user = userEvent.setup();
      await waitFor(() => screen.getByRole('button', { name: 'Disconnect (data stays local)' }));
      await user.click(screen.getByRole('button', { name: 'Disconnect (data stays local)' }));
      await waitFor(() => screen.getByText('Local only'));

      userId = 'user-2';
      await fillAndConnect('Connect (log in)');
      await waitFor(() => screen.getByRole('button', { name: 'Reset local sync state for this account and connect' }));
      expect(screen.queryByText(/Synced via account/)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Reset local sync state for this account and connect' }));
      await waitFor(() => expect(screen.getByText('Synced via account: me@example.test')).toBeTruthy());
      const row = await device.client.execute(`SELECT value FROM _sync_state WHERE key = 'user_id'`);
      expect(row.rows[0].value).toBe('user-2');
      expect(server.liveRows('user-2', 'tags').map((t) => t.name)).toContain('mine');
    });
  });
});

describe('Settings account panel on the web', () => {
  const SUMMARY = { pushed: 0, pulled: 0, superseded: 2, retrying: 0, held: 1, rejected: 0, clockSkew: false };
  let state: Record<string, unknown>;
  let erased: { erased: boolean; reason?: string };
  let calls: string[];

  beforeEach(() => {
    calls = [];
    erased = { erased: false, reason: 'Your data was kept on this device because 2 changes have not synced yet.' };
    state = {
      platform: 'web', mode: 'hosted', signedIn: true, email: 'me@example.test',
      lastSyncAt: null, pendingCount: 2, heldCount: 1, rejectedCount: 0, persistent: true,
    };
    const b = bridge();
    b.platform = 'web';
    const prev = b.call;
    b.call = async (ns, fn, args) => {
      if (ns !== 'account') return prev(ns, fn, args);
      calls.push(fn);
      if (fn === 'getSyncState') return { ...state };
      if (fn === 'syncNow') return SUMMARY;
      if (fn === 'disconnect') { state = { ...state, mode: 'byok', signedIn: false, email: null }; return; }
      if (fn === 'signOutAndErase') return erased;
      return undefined;
    };
  });

  it('shows the signed-in panel with counts, hides the desktop-only Configuration and Backup', async () => {
    renderScreen(<Settings />);
    await waitFor(() => expect(screen.getByText('Synced via account: me@example.test')).toBeTruthy());
    expect(screen.getByText('Pending changes').nextSibling?.textContent).toBe('2');
    expect(screen.getByText('Waiting on other data').nextSibling?.textContent).toBe('1');
    expect(screen.queryByText('Configuration')).toBeNull();
    expect(screen.queryByText('Backup')).toBeNull();
  });

  it('Sync now reports merged edits and waiting changes in plain words', async () => {
    renderScreen(<Settings />);
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole('button', { name: 'Sync now' }));
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => {
      const t = screen.getByRole('status').textContent ?? '';
      expect(t).toContain('2 edits merged with newer changes');
      expect(t).toContain('1 change waiting on other data, will retry');
    });
  });

  it('plain Sign out is one click and says the data stays in the browser', async () => {
    renderScreen(<Settings />);
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole('button', { name: /^Sign out \(data stays/ }));
    await user.click(screen.getByRole('button', { name: /^Sign out \(data stays/ }));
    await waitFor(() => expect(screen.getByText('Signed out. Your data stays in this browser.')).toBeTruthy());
    expect(calls).not.toContain('signOutAndErase');
  });

  it('Sign out and erase needs the typed word, and shows why when the data was kept', async () => {
    renderScreen(<Settings />);
    const user = userEvent.setup();
    await waitFor(() => screen.getByRole('button', { name: /Sign out and erase this device/ }));
    await user.click(screen.getByRole('button', { name: /Sign out and erase this device/ }));
    const confirm = screen.getByRole('button', { name: 'Sign out and erase' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Type erase to confirm'), 'eras');
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Type erase to confirm'), 'e');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(screen.getByText(/Nothing was erased\. Your data was kept on this device because 2 changes/)).toBeTruthy());
    expect(calls).toContain('signOutAndErase');
  });

  it('local-only browser shows the connect form with the disclosure and a not-persistent notice', async () => {
    state = { ...state, mode: 'byok', signedIn: false, email: null, persistent: false };
    renderScreen(<Settings />);
    await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());
    expect(screen.getByText('Syncing sends your data to your account on the server.')).toBeTruthy();
    expect(screen.getByText(/not keeping your data between visits/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /erase/i })).toBeNull();
  });
});
