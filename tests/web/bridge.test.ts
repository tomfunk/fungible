// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

const h = vi.hoisted(() => ({ client: null as unknown as Client, resets: 0 }));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const v = (h.client as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.client) : v;
    },
  }),
}));
vi.mock('../../core/db.browser.js', () => ({
  isPersistent: () => true,
  resetBrowserDb: async () => { h.resets++; },
  initDb: async () => {},
}));

import { makeDevice, q, type Device } from '../sync/harness.js';
import { FakeServer, fakeJwt } from '../sync/fakeServer.js';
import { registry } from '../../gui/main/registry.js';

let device: Device;
let server: FakeServer;
let bridge: { platform?: string; call(ns: string, fn: string, args: unknown[]): Promise<unknown> };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  device = await makeDevice('fungible-webbridge-');
  h.client = device.client;
  h.resets = 0;
  server = new FakeServer();
  const token = fakeJwt('user-1', 'me@example.test');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/login' || path === '/auth/register') return json({ accessToken: token });
    if (path === '/auth/refresh') return json({ accessToken: token });
    if (path === '/auth/logout') return json({ ok: true });
    return server.fetch(input, init);
  }));
  vi.resetModules();
  const mod = await import('../../web/src/bridge.js');
  mod.installBridge();
  bridge = (window as unknown as { __bridge: typeof bridge }).__bridge;
});
afterEach(async () => {
  const c = await import('../../web/src/account-client.js');
  c.stopBackgroundCycles();
  vi.unstubAllGlobals();
  device.close();
});

const call = (ns: string, fn: string, ...args: unknown[]) => bridge.call(ns, fn, args);

describe('web bridge', () => {
  it('identifies itself as the web platform (the renderer hides .env/key-backup panels on it)', () => {
    expect(bridge.platform).toBe('web');
  });

  it('serves the shared screens from the local database through the core registry', async () => {
    await device.client.execute("INSERT INTO tags (name) VALUES ('travel')");
    const tags = (await call('tags', 'getTagOptions')) as { name: string }[];
    expect(tags.map((t) => t.name)).toContain('travel');
  });

  it('starts local-only: account state, plaid and sync are inert and make no request', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(await call('account', 'getSyncState')).toMatchObject({
      platform: 'web', mode: 'byok', signedIn: false, pendingCount: 0, persistent: true,
    });
    expect(await call('plaid', 'isConfigured')).toBe(false);
    const res = (await call('sync', 'syncAll', true)) as { skipped: boolean; error?: string }[];
    expect(res[0]).toMatchObject({ skipped: true });
    expect(res[0].error).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('account.connect signs in, pulls, and the panel state reflects the connection', async () => {
    server.putAccount('user-1', { id: 'a1', name: 'Checking', type: 'depository' });
    server.putTransaction('user-1', { id: 't1', account_id: 'a1', date: '2026-02-03', name: 'Rent', amount: 1000 });

    const r = (await call('account', 'connect', 'me@example.test', 'hunter22', {})) as { status: string };
    expect(r.status).toBe('connected');

    expect(await call('account', 'getSyncState')).toMatchObject({ mode: 'hosted', signedIn: true, email: 'me@example.test' });
    expect(await call('plaid', 'isConfigured')).toBe(true);
    expect((await q(device.client, 'SELECT name FROM transactions'))).toEqual([{ name: 'Rent' }]);
    expect(typeof (await call('sync', 'getLastSyncedAt'))).toBe('number');
  });

  it('account.syncNow returns the cycle summary and throws the failure text when the cycle fails', async () => {
    await call('account', 'connect', 'me@example.test', 'hunter22', {});
    const ok = (await call('account', 'syncNow')) as { pushed: number; rejected: number };
    expect(ok).toMatchObject({ pushed: 0, rejected: 0 });

    server.opsEnabled = true;
    server.failPosts = 1;
    await device.client.execute("INSERT INTO tags (name) VALUES ('x')");
    await expect(call('account', 'syncNow')).rejects.toThrow();
  });

  it('account.disconnect keeps data; signOutAndErase clears it only through the guarded call', async () => {
    await call('account', 'connect', 'me@example.test', 'hunter22', {});
    await device.client.execute("INSERT INTO tags (name) VALUES ('keepme')");

    await call('account', 'disconnect');
    expect(h.resets).toBe(0);
    expect((await q(device.client, "SELECT name FROM tags WHERE name = 'keepme'")).length).toBe(1);
    expect(await call('account', 'getSyncState')).toMatchObject({ mode: 'byok', signedIn: false });

    await call('account', 'connect', 'me@example.test', 'hunter22', {});
    expect(await call('account', 'signOutAndErase')).toEqual({ erased: true });
    expect(h.resets).toBe(1);
  });

  it('rejects unknown calls instead of hanging', async () => {
    await expect(call('account', 'nope')).rejects.toThrow(/unknown call account\.nope/);
    await expect(call('nope', 'nothing')).rejects.toThrow();
  });
});

// The browser registry is a hand-maintained copy of gui/main/registry.ts (the
// Electron one pulls in node:fs etc.). It must not drift: a function the
// desktop renderer can call but the web one cannot is a silent hole.
describe('browser registry tracks gui/main/registry.ts', () => {
  // Calls the web bridge answers itself (web/src/bridge.ts) or that have no
  // browser story; each is a deliberate decision, not drift.
  const NOT_IN_BROWSER_REGISTRY = new Set([
    'accounts.checkKeyHealth', // stubbed in bridge.ts: the sync server holds keys
    'canvas.loadHistory', 'canvas.deleteHistoryEntry', 'canvas.loadCurrentSpec', 'canvas.updateSpec', // stubbed in bridge.ts
    'config.writeEnv', // local .env: desktop only
    'sync.syncAll', 'sync.deleteCursorAndResync', 'sync.getStatus', 'sync.getLastSyncedAt', 'sync.isSyncing', // bridge.ts
  ]);

  it('has every other desktop registry function', async () => {
    const { browserRegistry } = await import('../../web/src/core-bridge.js');
    const missing: string[] = [];
    for (const [ns, fns] of Object.entries(registry)) {
      for (const fn of Object.keys(fns)) {
        const key = `${ns}.${fn}`;
        if (NOT_IN_BROWSER_REGISTRY.has(key)) continue;
        if (typeof (browserRegistry as Record<string, Record<string, unknown>>)[ns]?.[fn] !== 'function') missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('adds nothing the desktop registry lacks', async () => {
    const { browserRegistry } = await import('../../web/src/core-bridge.js');
    const extra: string[] = [];
    for (const [ns, fns] of Object.entries(browserRegistry)) {
      for (const fn of Object.keys(fns)) {
        if (!(registry as Record<string, Record<string, unknown>>)[ns] || !(fn in (registry as Record<string, Record<string, unknown>>)[ns])) {
          extra.push(`${ns}.${fn}`);
        }
      }
    }
    expect(extra).toEqual([]);
  });
});
