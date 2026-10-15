/**
 * Two-device operation-log sync against a live sync server, through the Node
 * engine and the real product write paths (rules, tags, settings, profile).
 *
 * Skipped unless FUNGIBLE_SYNC_TEST_URL is set, and skipped (not failed) when the
 * server answers 404 to POST /sync/ops, i.e. it has not deployed the oplog
 * protocol yet:
 *   FUNGIBLE_SYNC_TEST_URL=http://localhost:3000 npx vitest run tests/sync/live.test.ts
 *
 * Each "device" is a file-backed libsql DB in a temp dir with the test
 * schema. Nothing touches ~/.fungible. A throwaway account is registered.
 */
import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import type { Client } from '@libsql/client';

const h = vi.hoisted(() => ({ client: null as unknown as Client }));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get: (_t, k) => {
      const v = (h.client as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.client) : v;
    },
  }),
}));

import { makeDevice, q, type Device } from './harness.js';
import {
  configureAuth, register, memoryAuthAdapter, sessionUserId, getAccessToken, type AuthAdapter,
} from '../../core/auth-client.js';
import { configureSync, runSyncCycle, getSyncInfo } from '../../core/sync-client.js';
import { enableHostedMode, disableHostedMode } from '../../core/sync-mode.js';
import { saveCategoryRule } from '../../core/rules.js';
import { createTag, deleteTag } from '../../core/tags.js';
import { setSetting } from '../../core/settings.js';

const URL_ = process.env.FUNGIBLE_SYNC_TEST_URL;
const email = () => `live+${Date.now()}+${Math.random().toString(36).slice(2, 8)}@fungible.test`;
const PW = 'test-password-123';

let oplogDeployed = false;
const devices: Device[] = [];
afterAll(() => { for (const d of devices) d.close(); });

type Dev = { d: Device; adapter: AuthAdapter };
async function dev(adapter: AuthAdapter): Promise<Dev> {
  const d = await makeDevice('fungible-live-');
  devices.push(d);
  return { d, adapter };
}
function use(x: Dev): void {
  h.client = x.d.client;
  configureAuth(x.adapter, URL_!);
  configureSync(URL_!);
}

beforeAll(async () => {
  if (!URL_) return;
  // Probe with a throwaway account: does POST /sync/ops exist?
  const adapter = memoryAuthAdapter();
  configureAuth(adapter, URL_);
  try {
    await register(email(), PW);
    const token = await getAccessToken();
    const res = await fetch(`${URL_}/sync/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_id: 'probe', ops: [] }),
    });
    oplogDeployed = res.status !== 404;
  } catch { oplogDeployed = false; }
});

describe('live: operation-log sync (skipped without FUNGIBLE_SYNC_TEST_URL or a deployed /sync/ops)', () => {
  const run = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (!URL_ || !oplogDeployed) ctx.skip();
      await fn();
    });

  run('two devices converge; deletes propagate; BYOK edits push after re-enable', async () => {
    const e = email();
    const a = await dev(memoryAuthAdapter());
    use(a);
    await register(e, PW);
    const uid = (await sessionUserId())!;
    await enableHostedMode({ userId: uid, client: a.d.client, dataDir: a.d.dir });

    await saveCategoryRule({ pattern: 'STARBUCKS', matchType: 'name', category: 'Coffee', minAmount: null, maxAmount: null });
    await createTag('vacation');
    await setSetting('pretax_monthly', '750');
    await setSetting('theme', 'dark'); // local-only
    const sa = await runSyncCycle({ client: a.d.client });
    expect(sa.errors).toEqual([]);

    // Device B: same account, fresh install.
    const b = await dev(memoryAuthAdapter({ access: (await getAccessToken())! }));
    use(b);
    await enableHostedMode({ userId: uid, client: b.d.client, dataDir: b.d.dir });
    const sb = await runSyncCycle({ client: b.d.client });
    expect(sb.errors).toEqual([]);
    expect((await q(b.d.client, "SELECT category FROM category_rules WHERE pattern = 'STARBUCKS'"))[0]).toEqual({ category: 'Coffee' });
    expect((await q(b.d.client, "SELECT name FROM tags")).map((r) => r.name)).toEqual(['vacation']);
    expect((await q(b.d.client, "SELECT value FROM settings WHERE key = 'pretax_monthly'"))[0]).toEqual({ value: '750' });
    expect(await q(b.d.client, "SELECT value FROM settings WHERE key = 'theme'")).toEqual([]);

    // Delete on A reaches B.
    use(a);
    const tag = (await q(a.d.client, "SELECT id FROM tags WHERE name = 'vacation'"))[0];
    await deleteTag(Number(tag.id));
    await runSyncCycle({ client: a.d.client });
    use(b);
    await runSyncCycle({ client: b.d.client });
    expect(await q(b.d.client, 'SELECT * FROM tags')).toEqual([]);

    // Edits made on B while in BYOK push after re-enable.
    await disableHostedMode(b.d.client);
    await createTag('offline');
    expect((await runSyncCycle({ client: b.d.client })).inert).toBe('byok');
    await enableHostedMode({ userId: uid, client: b.d.client, dataDir: b.d.dir });
    await runSyncCycle({ client: b.d.client });
    use(a);
    await runSyncCycle({ client: a.d.client });
    expect((await q(a.d.client, 'SELECT name FROM tags')).map((r) => r.name)).toEqual(['offline']);
    const info = await getSyncInfo(a.d.client);
    expect(info.pendingCount).toBe(0);
    expect(info.rejectedCount).toBe(0);
  });
});
