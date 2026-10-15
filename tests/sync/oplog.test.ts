import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

// Product modules (tags.ts, rules.ts, ...) import the shared `db`; route it to
// whichever test device is current so no test ever touches ~/.fungible.
const h = vi.hoisted(() => ({ client: null as unknown as Client }));
vi.mock('../../core/db.js', () => ({
  db: new Proxy({}, {
    get: (_t, k) => {
      const v = (h.client as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.client) : v;
    },
  }),
}));

import { makeDevice, connect, q, type Device } from './harness.js';
import { FakeServer } from './fakeServer.js';
import { runSyncCycle, getSyncInfo } from '../../core/sync-client.js';
import {
  enableHostedMode, disableHostedMode, getSyncMode, SyncError, readSyncState,
} from '../../core/sync-mode.js';
import { createTag, renameTag, deleteTag, addTagToTransaction } from '../../core/tags.js';
import { saveCategoryRule, deleteCategoryRule, setCategoryFlexibility, createCategory } from '../../core/rules.js';
import { listSnapshots } from '../../core/snapshot.js';
import { deriveTagUuid } from '../../core/sync-ids.js';

const USER = 'user-1';
let server: FakeServer;
let devices: Device[];

async function device(): Promise<Device> {
  const d = await makeDevice();
  devices.push(d);
  return d;
}
const use = (d: Device) => { h.client = d.client; };
const enable = (d: Device, userId = USER) => enableHostedMode({ userId, client: d.client, dataDir: d.dir });
const cycle = (d: Device) => { use(d); return runSyncCycle({ client: d.client }); };

beforeEach(() => {
  server = new FakeServer();
  devices = [];
  connect(server, USER);
});
afterEach(() => { for (const d of devices) d.close(); });

describe('BYOK stays inert', () => {
  it('runs no network and creates no sync schema', async () => {
    const d = await device();
    use(d);
    await createTag('travel');
    const stats = await runSyncCycle({ client: d.client });
    expect(stats.inert).toBe('byok');
    expect(server.requests).toHaveLength(0);
    const objs = await q<{ name: string }>(d.client, `SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\' OR name LIKE '\\_sync%' ESCAPE '\\'`);
    expect(objs).toEqual([]);
    expect(await getSyncMode(d.client)).toBe('byok');
    const info = await getSyncInfo(d.client);
    expect(info.mode).toBe('byok');
    expect(info.pendingCount).toBe(0);
    expect(info.dirtyCount).toBe(0);
  });

  it('disable on a never-enabled database is a no-op', async () => {
    const d = await device();
    await disableHostedMode(d.client);
    const t = await q(d.client, `SELECT name FROM sqlite_master WHERE name = '_sync_state'`);
    expect(t).toEqual([]);
  });
});

describe('enableHostedMode', () => {
  it('snapshots first, then installs oplog, triggers and a backfill for existing rows', async () => {
    const d = await device();
    use(d);
    await createTag('travel');
    await createCategory('Pets');
    await saveCategoryRule({ matchType: 'name', pattern: 'COSTCO', category: 'Shopping', minAmount: null, maxAmount: null });
    await d.client.execute({ sql: "INSERT INTO settings (key, value) VALUES ('theme', 'dark'), ('pretax_monthly', '500')" });

    await enable(d);

    expect(listSnapshots(d.dir).map((s) => s.manifest.reason)).toEqual(['pre-enable-sync']);
    expect(await getSyncMode(d.client)).toBe('hosted');
    const triggers = await q<{ name: string }>(d.client, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_sync_%'`);
    expect(triggers.length).toBeGreaterThan(10);
    const ops = await q<{ tbl: string; origin: string }>(d.client, 'SELECT tbl, origin FROM _oplog ORDER BY seq');
    expect(ops.every((o) => o.origin === 'backfill')).toBe(true);
    const tbls = ops.map((o) => o.tbl);
    expect(tbls).toEqual(expect.arrayContaining(['tags', 'categories', 'category_rules', 'settings']));
    // 'theme' and device_id are local-only: never backfilled.
    const settingKeys = (await q<{ pk: string }>(d.client, `SELECT pk FROM _oplog WHERE tbl = 'settings'`)).map((r) => JSON.parse(r.pk).key);
    expect(settingKeys).toEqual(['pretax_monthly']);
  });

  it('fails closed: a failing snapshot aborts and leaves the database untouched', async () => {
    const d = await device();
    use(d);
    await createTag('travel');
    const before = await q(d.client, `SELECT name, sql FROM sqlite_master ORDER BY name`);
    const settingsBefore = await q(d.client, 'SELECT * FROM settings');
    await expect(enableHostedMode({
      userId: USER, client: d.client, snapshot: async () => { throw new Error('disk full'); },
    })).rejects.toMatchObject({ code: 'snapshot_failed' });
    expect(await q(d.client, `SELECT name, sql FROM sqlite_master ORDER BY name`)).toEqual(before);
    expect(await q(d.client, 'SELECT * FROM settings')).toEqual(settingsBefore);
    expect(await getSyncMode(d.client)).toBe('byok');
  });

  it('refuses a different account unless told to reset', async () => {
    const d = await device();
    await enable(d);
    await expect(enable(d, 'someone-else')).rejects.toBeInstanceOf(SyncError);
    await expect(enable(d, 'someone-else')).rejects.toMatchObject({ code: 'account_mismatch' });
    expect(await readSyncState('user_id', d.client)).toBe(USER);
  });
});

describe('triggers capture product writes', () => {
  it('logs inserts, partial updates and deletes with the right pk and fields', async () => {
    const d = await device();
    await enable(d);
    use(d);
    await d.client.execute('DELETE FROM _oplog');

    await createTag('travel');
    const tag = (await q<{ id: number }>(d.client, `SELECT id FROM tags WHERE name = 'travel'`))[0];
    await renameTag(tag.id, 'trips');
    await setCategoryFlexibility('Rent', 'fixed'); // no categories row: no-op
    await createCategory('Pets');
    await setCategoryFlexibility('Pets', 'flexible');
    await deleteTag(tag.id);

    const ops = (await q<{ tbl: string; kind: string; pk: string; fields: string | null; hlc: string; pushed: number }>(
      d.client, 'SELECT tbl, kind, pk, fields, hlc, pushed FROM _oplog ORDER BY seq')).map((o) => ({
      ...o, pk: JSON.parse(o.pk), fields: o.fields ? JSON.parse(o.fields) : null,
    }));
    const tags = ops.filter((o) => o.tbl === 'tags');
    expect(tags.map((o) => o.kind)).toEqual(['upsert', 'upsert', 'delete']);
    expect(tags[0].fields).toEqual({ name: 'travel' });
    expect(tags[1].fields).toEqual({ name: 'trips' }); // partial: only the changed field
    expect(tags[2].fields).toBeNull();
    expect(tags[0].pk.lid).toBe(tag.id);

    const cats = ops.filter((o) => o.tbl === 'categories');
    expect(cats.map((o) => o.fields)).toEqual([{ flexibility: null }, { flexibility: 'flexible' }]);
    // HLCs are fixed-width, strictly increasing within a device.
    const hlcs = ops.map((o) => o.hlc);
    for (const x of hlcs) expect(x).toMatch(/^\d{15}-\d{5}-.+$/);
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(new Set(hlcs).size).toBe(hlcs.length);
    expect(ops.every((o) => o.pushed === 0)).toBe(true);
  });

  it('never logs denied settings, device_id or account-scoped rules', async () => {
    const d = await device();
    await enable(d);
    use(d);
    await d.client.execute('DELETE FROM _oplog');
    await d.client.execute("INSERT INTO settings (key, value) VALUES ('theme', 'dark')");
    await d.client.execute("INSERT INTO settings (key, value) VALUES ('plaid_default_start_date', '2025-01-01')");
    await d.client.execute("UPDATE settings SET value = '2024-06-01' WHERE key = 'plaid_default_start_date'");
    await d.client.execute("INSERT INTO category_rules (match_type, pattern, category, account_id) VALUES ('name', 'X', 'Y', 'acct-1')");
    await d.client.execute("UPDATE category_rules SET category = 'Z' WHERE pattern = 'X'");
    const ops = await q<{ tbl: string; pk: string; fields: string }>(d.client, 'SELECT tbl, pk, fields FROM _oplog ORDER BY seq');
    expect(ops.map((o) => `${o.tbl}:${JSON.parse(o.pk).key}`)).toEqual([
      'settings:plaid_default_start_date', 'settings:plaid_default_start_date',
    ]);
  });

  it('does not log writes made while the engine is applying', async () => {
    const d = await device();
    await enable(d);
    await d.client.execute('DELETE FROM _oplog');
    await d.client.execute(`INSERT INTO _sync_state (key, value) VALUES ('applying', '1')`);
    await d.client.execute("INSERT INTO tags (name) VALUES ('quiet')");
    await d.client.execute(`DELETE FROM _sync_state WHERE key = 'applying'`);
    await d.client.execute("INSERT INTO tags (name) VALUES ('loud')");
    const ops = await q<{ fields: string }>(d.client, 'SELECT fields FROM _oplog');
    expect(ops.map((o) => JSON.parse(o.fields).name)).toEqual(['loud']);
  });
});

describe('push and pull', () => {
  it('uploads local state, derives ids from natural keys, and a second device converges', async () => {
    const a = await device();
    use(a);
    await createTag('travel');
    await saveCategoryRule({ matchType: 'name', pattern: 'COSTCO', category: 'Shopping', minAmount: null, maxAmount: null });
    await enable(a);
    const s1 = await cycle(a);
    expect(s1.errors).toEqual([]);
    expect(s1.pushed).toBeGreaterThan(0);

    const tagId = await deriveTagUuid(USER, 'travel');
    expect(server.row(USER, 'tags', { id: tagId })).toEqual({ name: 'travel' });
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);

    const b = await device();
    await enable(b);
    const s2 = await cycle(b);
    expect(s2.errors).toEqual([]);
    expect((await q(b.client, "SELECT name, uuid FROM tags"))).toEqual([{ name: 'travel', uuid: tagId }]);
    const rules = await q(b.client, "SELECT pattern, category FROM category_rules WHERE pattern = 'COSTCO'");
    expect(rules).toHaveLength(1);
  });

  it('second cycle with nothing new sends nothing and applies nothing', async () => {
    const a = await device();
    use(a);
    await enable(a);
    await cycle(a);
    const posts = () => server.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    const s = await cycle(a);
    expect(s.pushed).toBe(0);
    expect(posts()).toBe(before);
  });
});
