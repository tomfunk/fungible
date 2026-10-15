import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

const h = vi.hoisted(() => ({ client: null as unknown as Client }));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      const v = (h.client as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.client) : v;
    },
  }),
}));

import { makeDevice, type Device } from '../sync/harness.js';
import { FakeServer, fakeJwt } from '../sync/fakeServer.js';
import {
  configureSyncFromEnv, startSyncBackgroundIfConnected, stopSyncBackground, summarize,
} from '../../gui/main/account-sync.js';
import { isAuthConfigured, configureAuth, memoryAuthAdapter } from '../../core/auth-client.js';
import { configureSync, stopBackgroundSync } from '../../core/sync-client.js';

let device: Device;
let server: FakeServer;
const savedUrl = process.env.FUNGIBLE_SYNC_URL;

beforeEach(async () => {
  device = await makeDevice('fungible-main-acct-');
  h.client = device.client;
  server = new FakeServer();
  delete process.env.FUNGIBLE_SYNC_URL;
});
afterEach(() => {
  stopBackgroundSync();
  stopSyncBackground();
  vi.restoreAllMocks();
  if (savedUrl === undefined) delete process.env.FUNGIBLE_SYNC_URL; else process.env.FUNGIBLE_SYNC_URL = savedUrl;
  device.close();
});

describe('configureSyncFromEnv', () => {
  it('is off without FUNGIBLE_SYNC_URL', () => {
    expect(configureSyncFromEnv()).toBe(false);
    expect(isAuthConfigured()).toBe(false);
  });

  it('is off in demo mode even with FUNGIBLE_SYNC_URL set', () => {
    process.env.FUNGIBLE_SYNC_URL = 'https://sync.test';
    expect(configureSyncFromEnv({ demo: true })).toBe(false);
    expect(isAuthConfigured()).toBe(false);
  });

  it('configures the engine when FUNGIBLE_SYNC_URL is set', () => {
    process.env.FUNGIBLE_SYNC_URL = 'https://sync.test';
    expect(configureSyncFromEnv()).toBe(true);
    expect(isAuthConfigured()).toBe(true);
  });
});

describe('background sync start', () => {
  const fetchSpy = () => vi.spyOn(globalThis, 'fetch').mockImplementation((u, i) => server.fetch(u as string, i));

  it('does nothing for a local-only install (no request, no timer)', async () => {
    configureAuth(memoryAuthAdapter({ access: fakeJwt('u1'), refresh: 'r' }), 'http://sync.test', { fetch: server.fetch });
    configureSync('http://sync.test', { fetch: server.fetch });
    const spy = fetchSpy();
    await startSyncBackgroundIfConnected();
    expect(spy).not.toHaveBeenCalled();
    expect(server.requests).toEqual([]);
  });

  it('does nothing for a connected install that has no session', async () => {
    configureAuth(memoryAuthAdapter(), 'http://sync.test', { fetch: server.fetch });
    configureSync('http://sync.test', { fetch: server.fetch });
    // Connect once so the database is in hosted mode...
    configureAuth(memoryAuthAdapter({ access: fakeJwt('u1'), refresh: 'r' }), 'http://sync.test', { fetch: server.fetch });
    const { enableHostedMode } = await import('../../core/sync-mode.js');
    await enableHostedMode({ userId: 'u1', client: device.client, dataDir: device.dir });
    // ...then lose the session.
    configureAuth(memoryAuthAdapter(), 'http://sync.test', { fetch: server.fetch });
    await startSyncBackgroundIfConnected();
    expect(server.requests).toEqual([]);
  });
});

describe('summarize', () => {
  it('maps engine stats to what the panel shows', () => {
    const s = summarize({
      pushed: 4, adopted: 0, pullApplied: 7, pullSkipped: 0, superseded: 3, conflictsRebased: 3,
      errors: [{ table: 't', id: 1, reason: 'stale', server_row: null }], conflicts: [], retrying: 2, clockSkew: true,
    }, 5);
    expect(s).toEqual({ pushed: 4, pulled: 7, superseded: 3, retrying: 2, held: 5, rejected: 1, clockSkew: true });
  });
});
