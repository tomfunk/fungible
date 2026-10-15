import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

// The engine imports `db` from core/db.js; point it at a throwaway file DB
// (the same schema every sync test uses). core/db.browser.ts needs a Worker and
// OPFS, so its two calls the web client makes are stubbed: that boundary is
// covered by the real-browser Playwright run, not here.
const h = vi.hoisted(() => ({ client: null as unknown as Client, resets: 0, persistent: true }));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const v = (h.client as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.client) : v;
    },
  }),
}));
vi.mock('../../core/db.browser.js', () => ({
  isPersistent: () => h.persistent,
  resetBrowserDb: async () => { h.resets++; },
  initDb: async () => {},
}));

import { makeDevice, q, type Device } from '../sync/harness.js';
import { FakeServer, fakeJwt } from '../sync/fakeServer.js';
import { SESSION_HINT_KEY } from '../../web/src/auth-adapter.js';

const BASE = 'http://localhost:3000';
const USER = 'user-1';

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

let device: Device;
let server: FakeServer;
let storage: ReturnType<typeof fakeLocalStorage>;
let requests: { method: string; path: string; credentials?: RequestCredentials }[];
/** Per-path overrides in front of the fake server (auth routes live here). */
let routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>;
let loggedInAs = USER;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function load(opts: { hint?: boolean } = {}) {
  storage = fakeLocalStorage(opts.hint ? { [SESSION_HINT_KEY]: '1' } : {});
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname, credentials: init?.credentials });
    const route = routes[url.pathname];
    if (route) return route(init);
    return server.fetch(input, init);
  }));
  vi.resetModules();
  return import('../../web/src/account-client.js');
}

beforeEach(async () => {
  device = await makeDevice('fungible-web-');
  h.client = device.client;
  h.resets = 0;
  h.persistent = true;
  server = new FakeServer();
  requests = [];
  loggedInAs = USER;
  const token = () => fakeJwt(loggedInAs, `${loggedInAs}@example.test`);
  routes = {
    '/auth/login': () => json({ accessToken: token(), refreshToken: 'cookie-only' }),
    '/auth/register': () => json({ accessToken: token(), refreshToken: 'cookie-only' }),
    '/auth/refresh': () => json({ accessToken: token() }),
    '/auth/logout': () => json({ ok: true }),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  device.close();
});

const calledPaths = () => requests.map((r) => r.path);

describe('resumeSession', () => {
  it('makes no network call when this browser has never logged in', async () => {
    const c = await load();
    expect(await c.resumeSession()).toBe('none');
    expect(requests).toHaveLength(0);
  });

  it('refreshes through the cookie when the hint is set', async () => {
    const c = await load({ hint: true });
    expect(await c.resumeSession()).toBe('resumed');
    expect(requests).toEqual([{ method: 'POST', path: '/auth/refresh', credentials: 'include' }]);
    expect(c.hasSession()).toBe(true);
  });

  it('a server outage is offline, not a logout: the hint survives and the banner says unreachable', async () => {
    routes['/auth/refresh'] = () => json({ error: 'down' }, 503);
    const c = await load({ hint: true });
    expect(await c.resumeSession()).toBe('offline');
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1');
    let state = '';
    c.subscribeConnState((s) => { state = s; });
    expect(state).toBe('unreachable');
  });

  it('a network failure is offline too', async () => {
    routes['/auth/refresh'] = () => { throw new TypeError('Failed to fetch'); };
    const c = await load({ hint: true });
    expect(await c.resumeSession()).toBe('offline');
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1');
  });

  it('a refused refresh ends the session and clears the hint', async () => {
    routes['/auth/refresh'] = () => json({ error: 'invalid_refresh_token' }, 401);
    const c = await load({ hint: true });
    expect(await c.resumeSession()).toBe('none');
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
  });

  it('never sends a refresh once the hint is gone, even from inside the engine', async () => {
    const c = await load();
    // getAccessToken() -> refresh() would POST with credentials:include; the
    // guard answers locally instead.
    const { getAccessToken } = await import('../../core/auth-client.js');
    expect(await getAccessToken()).toBeNull();
    expect(requests).toHaveLength(0);
    expect(c.hasSession()).toBe(false);
  });
});

describe('connect', () => {
  async function seedLocal() {
    await device.client.execute("INSERT INTO tags (name) VALUES ('mine')");
  }

  it('logs in, binds the database, pulls the account data immediately and sets the hint', async () => {
    server.putAccount(USER, { id: 'srv-acct', name: 'Server checking', type: 'depository' });
    server.putTransaction(USER, { id: 'srv-tx', account_id: 'srv-acct', date: '2026-01-02', name: 'Coffee', amount: 4.5 });
    const c = await load();

    const r = await c.connect('me@example.test', 'hunter22');

    expect(r.status).toBe('connected');
    if (r.status !== 'connected') return;
    expect(r.summary.pulled).toBeGreaterThan(0);
    const tx = await q(device.client, "SELECT name FROM transactions WHERE id = 'srv-tx'");
    expect(tx).toEqual([{ name: 'Coffee' }]);
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1');
    const state = await c.getAccountState();
    expect(state).toMatchObject({ platform: 'web', mode: 'hosted', signedIn: true, email: `${USER}@example.test`, persistent: true });
    c.stopBackgroundCycles();
  });

  it('wrong credentials throw and leave the app local-only', async () => {
    routes['/auth/login'] = () => json({ error: 'invalid_credentials' }, 401);
    const c = await load();
    await expect(c.connect('me@example.test', 'nope')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect((await c.getAccountState()).mode).toBe('byok');
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
  });

  it('registers a new account with createAccount', async () => {
    const c = await load();
    await c.connect('new@example.test', 'hunter22', { createAccount: true });
    expect(calledPaths()).toContain('/auth/register');
    expect(calledPaths()).not.toContain('/auth/login');
    c.stopBackgroundCycles();
  });

  it('reports account_mismatch, drops the session, and resetForNewAccount pushes local data to the new account', async () => {
    await seedLocal();
    let c = await load();
    await c.connect('a@example.test', 'hunter22');
    c.stopBackgroundCycles();

    loggedInAs = 'user-2';
    c = await load();
    expect(await c.connect('b@example.test', 'hunter22')).toEqual({ status: 'account_mismatch' });
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false); // no live session left for a refused account

    const r = await c.connect('b@example.test', 'hunter22', { resetForNewAccount: true });
    expect(r.status).toBe('connected');
    expect(server.liveRows('user-2', 'tags').map((t) => t.name)).toContain('mine');
    expect((await q(device.client, "SELECT value FROM _sync_state WHERE key = 'user_id'"))[0]).toEqual({ value: 'user-2' });
    c.stopBackgroundCycles();
  });

  it('never writes a snapshot: the browser DB has no file to protect', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const c = await load();
    await c.connect('me@example.test', 'hunter22');
    c.stopBackgroundCycles();
    // A default snapshot would land in <dataDir>/backups or snapshots.
    const dataDir = process.env.FUNGIBLE_DATA_DIR!;
    const leftovers = fs.existsSync(dataDir)
      ? fs.readdirSync(dataDir).filter((n) => /snapshot|pre-enable|backup/i.test(n) || fs.existsSync(path.join(dataDir, n, 'pre-enable-sync')))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe('sync results shown to the user', () => {
  const stats = (o: Record<string, unknown> = {}) => ({
    pushed: 0, adopted: 0, pullApplied: 0, pullSkipped: 0, superseded: 0, conflictsRebased: 0, errors: [], conflicts: [], ...o,
  });

  it('maps CycleStats to a summary: merged edits, retrying, held, rejected, clock skew', async () => {
    const c = await load();
    const r = c.cycleToResults(stats({
      pushed: 3, pullApplied: 2, superseded: 4, retrying: 1,
      errors: [{ table: 't', id: 1, reason: 'stale', server_row: null }], clockSkew: true,
    }) as never, 5);
    expect(r).toHaveLength(1);
    expect(r[0].error).toBeUndefined(); // rejected changes are counted, not a failed sync
    expect(r[0].added).toBe(2);
    expect(r[0].cycle).toEqual({ pushed: 3, pulled: 2, superseded: 4, retrying: 1, held: 5, rejected: 1, clockSkew: true });
  });

  it('shows what the renderer prints for those notes', async () => {
    const { cycleNotes } = await import('../../gui/shared/account-types.js');
    expect(cycleNotes({ superseded: 1, retrying: 1, held: 2, rejected: 2, clockSkew: true })).toEqual([
      '1 edit merged with newer changes',
      '3 changes waiting on other data, will retry',
      '2 changes rejected by the server',
      "this device's clock looks wrong, so some changes were not accepted; check the date and time",
    ]);
    expect(cycleNotes({ superseded: 0, retrying: 0, held: 0, rejected: 0, clockSkew: false })).toEqual([]);
  });

  it('a network failure is reported as unreachable, a server answer as error; neither signs out', async () => {
    const c = await load();
    await c.connect('me@example.test', 'hunter22');
    c.stopBackgroundCycles();

    server.failPosts = 1;
    await device.client.execute("INSERT INTO tags (name) VALUES ('t1')");
    const r500 = await c.syncNow();
    expect(r500[0].error).toBeTruthy();
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1');

    routes['/sync/ops'] = () => { throw new TypeError('Failed to fetch'); };
    const down = await c.syncNow();
    expect(down[0].error).toBeTruthy();
    let state = '';
    c.subscribeConnState((s) => { state = s; });
    expect(state).toBe('unreachable');
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1');
  });

  it('in local-only mode a sync is inert and makes no request', async () => {
    const c = await load();
    const r = await c.syncNow();
    expect(r[0].skipped).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe('background cycles', () => {
  it('make no request without a session or while local-only', async () => {
    vi.useFakeTimers();
    try {
      const c = await load();
      c.startBackgroundCycles(1000);
      await vi.advanceTimersByTimeAsync(5000);
      c.stopBackgroundCycles();
      expect(requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startSyncSession is a no-op for a local-only install even with a stale hint', async () => {
    const c = await load({ hint: true });
    await c.startSyncSession();
    c.stopBackgroundCycles();
    expect(requests).toHaveLength(0);
  });
});

describe('sign out', () => {
  async function connected() {
    const c = await load();
    await c.connect('me@example.test', 'hunter22');
    c.stopBackgroundCycles();
    return c;
  }

  it('plain sign out keeps every local row, turns sync off and clears the session', async () => {
    server.putAccount(USER, { id: 'srv-acct', name: 'Server checking', type: 'depository' });
    const c = await connected();
    expect((await q(device.client, 'SELECT COUNT(*) AS n FROM accounts'))[0]).toEqual({ n: 1 });

    await c.signOut();

    expect(h.resets).toBe(0);
    expect((await q(device.client, 'SELECT COUNT(*) AS n FROM accounts'))[0]).toEqual({ n: 1 });
    expect(await q(device.client, "SELECT value FROM _sync_state WHERE key = 'mode'")).toEqual([{ value: 'byok' }]);
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
    expect(calledPaths()).toContain('/auth/logout');
    expect((await c.getAccountState()).signedIn).toBe(false);
  });

  it('plain sign out pushes pending edits first (one final cycle)', async () => {
    const c = await connected();
    await device.client.execute("INSERT INTO tags (name) VALUES ('groceries')");
    await c.signOut();
    expect(server.liveRows(USER, 'tags').map((t) => t.name)).toContain('groceries');
  });

  it('plain sign out still signs out when the final cycle cannot run', async () => {
    const c = await connected();
    routes['/sync/ops'] = () => { throw new TypeError('Failed to fetch'); };
    await c.signOut();
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
    expect(h.resets).toBe(0);
  });

  it('sign out and erase wipes the device when everything is synced', async () => {
    const c = await connected();
    await device.client.execute("INSERT INTO tags (name) VALUES ('groceries')");

    const r = await c.signOutAndErase();

    expect(r).toEqual({ erased: true });
    expect(h.resets).toBe(1);
    expect(server.liveRows(USER, 'tags').map((t) => t.name)).toContain('groceries'); // nothing lost: it was pushed first
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
  });

  it('sign out and erase keeps the data and says why when the final cycle fails', async () => {
    const c = await connected();
    await device.client.execute("INSERT INTO tags (name) VALUES ('unsynced')");
    routes['/sync/ops'] = () => { throw new TypeError('Failed to fetch'); };

    const r = await c.signOutAndErase();

    expect(r.erased).toBe(false);
    if (!r.erased) expect(r.reason).toMatch(/kept on this device/);
    expect(h.resets).toBe(0);
    expect(storage.m.get(SESSION_HINT_KEY)).toBe('1'); // still signed in
    expect((await q(device.client, "SELECT COUNT(*) AS n FROM tags WHERE name = 'unsynced'"))[0]).toEqual({ n: 1 });
    c.stopBackgroundCycles();
  });
});

describe('eraseLocalData', () => {
  it('wipes the browser database and the session without any network call', async () => {
    const c = await load({ hint: true });
    await c.eraseLocalData();
    expect(h.resets).toBe(1);
    expect(storage.m.has(SESSION_HINT_KEY)).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
