import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { FakeServer, fakeJwt } from './fakeServer.js';
import { runSyncCycle, getSyncInfo, configureSync } from '../../core/sync-client.js';
import {
  enableHostedMode, disableHostedMode, getSyncMode, readSyncState, cursorKey, SyncError,
} from '../../core/sync-mode.js';
import { deriveTagUuid, deriveRuleUuid, deriveMemberUuid } from '../../core/sync-ids.js';
import { formatHlc } from '../../core/hlc.js';
import { spawnWriter } from '../helpers/tempFileDb.js';
import { configureAuth, memoryAuthAdapter } from '../../core/auth-client.js';

const USER = 'user-1';
let server: FakeServer;
let devices: Device[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const use = (d: Device) => { h.client = d.client; };

async function newDevice(user = USER): Promise<Device> {
  const d = await makeDevice('fungible-proto-');
  devices.push(d);
  use(d);
  await enableHostedMode({ userId: user, client: d.client, dataDir: d.dir });
  return d;
}
async function cycle(d: Device) { use(d); return runSyncCycle({ client: d.client }); }
const sql = (d: Device, s: string, a: (string | number | null)[] = []) => q(d.client, s, a);

beforeEach(() => {
  server = new FakeServer();
  devices = [];
  connect(server, USER);
});
afterEach(() => { for (const d of devices) d.close(); });

async function ruleOn(d: Device, pattern: string, category: string): Promise<void> {
  await d.client.execute({
    sql: `INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', ?, ?)`,
    args: [pattern, category],
  });
}

describe('last-writer-wins by field', () => {
  async function pairWithRule() {
    const a = await newDevice();
    const b = await newDevice();
    await ruleOn(a, 'COSTCO', 'Shopping');
    await cycle(a);
    await cycle(b);
    expect(await sql(b, "SELECT category FROM category_rules WHERE pattern = 'COSTCO'")).toEqual([{ category: 'Shopping' }]);
    return { a, b };
  }
  const rule = async (d: Device) => (await sql(d, "SELECT category, max_amount, priority FROM category_rules WHERE pattern = 'COSTCO'"))[0];

  it('disjoint fields edited concurrently both survive', async () => {
    const { a, b } = await pairWithRule();
    await a.client.execute("UPDATE category_rules SET category = 'Food' WHERE pattern = 'COSTCO'");
    await sleep(3);
    await b.client.execute("UPDATE category_rules SET max_amount = 100 WHERE pattern = 'COSTCO'");
    await cycle(b);
    await cycle(a);
    await cycle(b);
    expect(await rule(a)).toMatchObject({ category: 'Food', max_amount: 100 });
    expect(await rule(b)).toMatchObject({ category: 'Food', max_amount: 100 });
  });

  it('same field: the later edit wins even when the earlier one syncs last', async () => {
    const { a, b } = await pairWithRule();
    await a.client.execute("UPDATE category_rules SET category = 'Food' WHERE pattern = 'COSTCO'");
    await sleep(3);
    await b.client.execute("UPDATE category_rules SET category = 'Dining' WHERE pattern = 'COSTCO'"); // later HLC
    await cycle(b);
    const sa = await cycle(a); // A's older edit loses; it is told so
    expect(sa.superseded).toBeGreaterThanOrEqual(1);
    expect(sa.conflictsRebased).toBe(sa.superseded);
    expect(sa.errors).toEqual([]);
    await cycle(b);
    expect((await rule(a)).category).toBe('Dining');
    expect((await rule(b)).category).toBe('Dining');
    const id = await deriveRuleUuid(USER, 'category_rules', 'name', 'COSTCO');
    expect(server.row(USER, 'category_rules', { id })).toMatchObject({ category: 'Dining' });
  });

  it('same field, other direction: the later edit syncing FIRST still loses to a newer one arriving after', async () => {
    const { a, b } = await pairWithRule();
    await b.client.execute("UPDATE category_rules SET category = 'Dining' WHERE pattern = 'COSTCO'");
    await sleep(3);
    await a.client.execute("UPDATE category_rules SET category = 'Food' WHERE pattern = 'COSTCO'"); // later HLC
    await cycle(b); // older edit reaches the server first
    await cycle(a); // newer edit wins
    await cycle(b);
    expect((await rule(a)).category).toBe('Food');
    expect((await rule(b)).category).toBe('Food');
  });

  it('a pulled older op does not overwrite a newer pending local edit', async () => {
    const { a, b } = await pairWithRule();
    await b.client.execute("UPDATE category_rules SET category = 'Dining' WHERE pattern = 'COSTCO'");
    await cycle(b);
    await sleep(3);
    await a.client.execute("UPDATE category_rules SET category = 'Food' WHERE pattern = 'COSTCO'"); // newer, unpushed
    // A pulls B's op first? The cycle pushes first, but force pull ordering by checking end state.
    await cycle(a);
    await cycle(b);
    expect((await rule(b)).category).toBe('Food');
    expect((await rule(a)).category).toBe('Food');
  });
});

describe('deletes', () => {
  it('a delete propagates, including dependent links', async () => {
    const a = await newDevice();
    const b = await newDevice();
    server.putAccount(USER, { id: 'acc', name: 'Chk', type: 'depository' });
    server.putTransaction(USER, { id: 'tx1', account_id: 'acc', date: '2026-07-01', name: 'X', amount: 1 });
    await a.client.execute("INSERT INTO tags (name) VALUES ('travel')");
    await cycle(a);
    await cycle(b);
    await a.client.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx1', 1)");
    await cycle(a);
    await cycle(b);
    expect(await sql(b, 'SELECT transaction_id FROM transaction_tags')).toEqual([{ transaction_id: 'tx1' }]);

    await a.client.execute('DELETE FROM transaction_tags WHERE tag_id = 1');
    await a.client.execute('DELETE FROM tags WHERE id = 1');
    await cycle(a);
    await cycle(b);
    expect(await sql(b, 'SELECT * FROM tags')).toEqual([]);
    expect(await sql(b, 'SELECT * FROM transaction_tags')).toEqual([]);
    expect(server.row(USER, 'tags', { id: await deriveTagUuid(USER, 'travel') })).toBeNull();
  });

  it('deleted then recreated converges on every device', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('travel')");
    await cycle(a);
    await cycle(b);
    await a.client.execute("DELETE FROM tags WHERE name = 'travel'");
    await cycle(a);
    await cycle(b);
    expect(await sql(b, 'SELECT * FROM tags')).toEqual([]);
    await sleep(3);
    await a.client.execute("INSERT INTO tags (name) VALUES ('travel')");
    await cycle(a);
    await cycle(b);
    const id = await deriveTagUuid(USER, 'travel');
    expect(server.row(USER, 'tags', { id })).toEqual({ name: 'travel' });
    expect(await sql(b, 'SELECT name, uuid FROM tags')).toEqual([{ name: 'travel', uuid: id }]);
    expect(await sql(a, 'SELECT name, uuid FROM tags')).toEqual([{ name: 'travel', uuid: id }]);
  });

  it('a delete newer than a concurrent edit wins; an edit newer than the delete revives', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('t1'), ('t2')");
    await cycle(a);
    await cycle(b);

    // t1: B edits, then A deletes (delete newer)
    await b.client.execute("UPDATE tags SET name = 't1-b' WHERE name = 't1'");
    await sleep(3);
    await a.client.execute("DELETE FROM tags WHERE name = 't1'");
    // t2: A deletes, then B edits (edit newer)
    await a.client.execute("DELETE FROM tags WHERE name = 't2'");
    await sleep(3);
    await b.client.execute("UPDATE tags SET name = 't2-b' WHERE name = 't2'");

    await cycle(a); await cycle(b); await cycle(a); await cycle(b);
    const names = async (d: Device) => (await sql(d, 'SELECT name FROM tags ORDER BY name')).map((r) => r.name);
    expect(await names(a)).toEqual(['t2-b']);
    expect(await names(b)).toEqual(['t2-b']);
  });
});

describe('offline, retries and idempotency', () => {
  it('edits made while the server is unreachable replay in full on the next cycle', async () => {
    const a = await newDevice();
    await cycle(a);
    server.opsEnabled = false; // POST /sync/ops -> 404 (not deployed / down)
    await a.client.execute("INSERT INTO tags (name) VALUES ('x'), ('y')");
    await a.client.execute("UPDATE tags SET name = 'x2' WHERE name = 'x'");
    await expect(cycle(a)).rejects.toMatchObject({ code: 'push_failed' });
    const pending = (await getSyncInfo(a.client)).pendingCount;
    expect(pending).toBeGreaterThan(0);
    server.opsEnabled = true;
    const s = await cycle(a);
    expect(s.errors).toEqual([]);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
    const live = server.liveRows(USER, 'tags').map((r) => r.name).sort();
    expect(live).toEqual(['x2', 'y']);
  });

  it('a transient 500 leaves ops queued and nothing is lost or duplicated', async () => {
    const a = await newDevice();
    await cycle(a);
    await a.client.execute("INSERT INTO tags (name) VALUES ('x')");
    server.failPosts = 1;
    await expect(cycle(a)).rejects.toMatchObject({ code: 'push_failed', status: 500 });
    await cycle(a);
    expect(server.liveRows(USER, 'tags')).toHaveLength(1);
  });

  it('re-pushing already accepted ops is idempotent by op_id', async () => {
    const a = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('x')");
    await cycle(a);
    const seqBefore = server.opsOf(USER).length;
    await a.client.execute("UPDATE _oplog SET pushed = 0 WHERE pushed = 1 AND origin IS NOT NULL"); // lost ack
    const s = await cycle(a);
    expect(s.errors).toEqual([]);
    expect(server.opsOf(USER).length).toBe(seqBefore);
    expect(server.liveRows(USER, 'tags')).toHaveLength(1);
  });

  it('402 surfaces as not_paid and keeps local ops queued', async () => {
    const a = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('x')");
    server.unpaid.add(USER);
    await expect(cycle(a)).rejects.toMatchObject({ code: 'not_paid', status: 402 });
    expect((await getSyncInfo(a.client)).pendingCount).toBeGreaterThan(0);
    server.unpaid.delete(USER);
    await cycle(a);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
  });
});

describe('pull: paging, cursor, resume', () => {
  it('pages through more ops than one page and applies them all', async () => {
    const a = await newDevice();
    server.putAccount(USER, { id: 'acc', name: 'Chk', type: 'depository' });
    await cycle(a);
    for (let i = 0; i < 1200; i++) {
      server.putTransaction(USER, { id: `t${i}`, account_id: 'acc', date: '2026-07-01', name: `M${i}`, amount: i });
    }
    const s = await cycle(a);
    expect(s.pullApplied).toBeGreaterThanOrEqual(1200);
    expect(Number((await sql(a, 'SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(1200);
    expect(await readSyncState(cursorKey(USER), a.client)).toBe(String(server.user(USER).seq));
    const gets = server.requests.filter((r) => r.method === 'GET' && r.path === '/sync/ops').length;
    expect(gets).toBeGreaterThanOrEqual(3);
  });

  it('resumes from the last committed page after a failure mid-pull', async () => {
    const a = await newDevice();
    server.putAccount(USER, { id: 'acc', name: 'Chk', type: 'depository' });
    await cycle(a);
    const start = server.user(USER).seq;
    for (let i = 0; i < 1100; i++) {
      server.putTransaction(USER, { id: `t${i}`, account_id: 'acc', date: '2026-07-01', name: `M${i}`, amount: i });
    }
    // The connection drops while fetching the second page.
    let gets = 0;
    const flaky: typeof fetch = async (u, init) => {
      if (String(u).includes('/sync/ops') && (init?.method ?? 'GET') === 'GET' && ++gets === 2) throw new TypeError('network down');
      return server.fetch(u, init);
    };
    configureSync('http://sync.test', { fetch: flaky });
    await expect(cycle(a)).rejects.toThrow('network down');
    // Page one is applied and the cursor sits exactly after it, atomically.
    expect(await readSyncState(cursorKey(USER), a.client)).toBe(String(start + 500));
    expect(Number((await sql(a, 'SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(500);

    configureSync('http://sync.test', { fetch: server.fetch });
    await cycle(a);
    expect(Number((await sql(a, 'SELECT COUNT(*) AS n FROM transactions'))[0].n)).toBe(1100);
    expect(await readSyncState(cursorKey(USER), a.client)).toBe(String(start + 1100));
  });

  it('a pulled op does not echo back: nothing is queued for it', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('shared')");
    await cycle(a);
    await cycle(b);
    expect((await getSyncInfo(b.client)).pendingCount).toBe(0);
    const pending = await sql(b, 'SELECT * FROM _oplog WHERE pushed = 0');
    expect(pending).toEqual([]);
    const posts = server.requests.filter((r) => r.method === 'POST').length;
    await cycle(b);
    expect(server.requests.filter((r) => r.method === 'POST').length).toBe(posts);
    expect(await sql(b, "SELECT value FROM _sync_state WHERE key = 'applying'")).toEqual([]);
  });

  it('410 re-bootstraps from a snapshot and keeps unpushed local ops', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await cycle(a);
    await b.client.execute("INSERT INTO tags (name) VALUES ('from-b')");
    await cycle(b);
    await a.client.execute("INSERT INTO tags (name) VALUES ('local-a')");
    server.compact(USER, server.user(USER).seq + 1); // everything A has not seen is gone from the log
    server.user(USER).minSeq = server.user(USER).seq + 1;
    const s = await cycle(a);
    expect(s.resynced).toBe(true);
    const names = (await sql(a, 'SELECT name FROM tags ORDER BY name')).map((r) => r.name);
    expect(names).toEqual(['from-b', 'local-a']);
    expect(server.liveRows(USER, 'tags').map((r) => r.name).sort()).toEqual(['from-b', 'local-a']);
  });
});

describe('mode switching', () => {
  it('BYOK <-> hosted round trip: edits made while in BYOK push on re-entry', async () => {
    const a = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('before')");
    await cycle(a);
    await disableHostedMode(a.client);
    expect(await getSyncMode(a.client)).toBe('byok');
    const reqs = server.requests.length;
    await a.client.execute("INSERT INTO tags (name) VALUES ('during-byok')");
    const inert = await cycle(a);
    expect(inert.inert).toBe('byok');
    expect(server.requests.length).toBe(reqs);

    await enableHostedMode({ userId: USER, client: a.client, dataDir: a.dir });
    const s = await cycle(a);
    expect(s.errors).toEqual([]);
    expect(server.liveRows(USER, 'tags').map((r) => r.name).sort()).toEqual(['before', 'during-byok']);
  });

  it('account_mismatch is raised by the cycle and by enable; reset re-queues data for the new account', async () => {
    const a = await newDevice();
    await a.client.execute("INSERT INTO tags (name) VALUES ('mine')");
    await cycle(a);
    connect(server, 'user-2');
    await expect(cycle(a)).rejects.toMatchObject({ code: 'account_mismatch' });
    await expect(enableHostedMode({ userId: 'user-2', client: a.client, dataDir: a.dir }))
      .rejects.toMatchObject({ code: 'account_mismatch' });
    // Nothing of user-1's data reached user-2.
    expect(server.liveRows('user-2', 'tags')).toEqual([]);

    await enableHostedMode({ userId: 'user-2', client: a.client, dataDir: a.dir, resetForNewAccount: true });
    const s = await cycle(a);
    expect(s.errors).toEqual([]);
    expect(server.liveRows('user-2', 'tags').map((r) => r.name)).toEqual(['mine']);
    // Ids are re-derived for the new account.
    expect(await sql(a, 'SELECT uuid FROM tags')).toEqual([{ uuid: await deriveTagUuid('user-2', 'mine') }]);
  });

  it('a connected device with no session cannot sync', async () => {
    const a = await newDevice();
    configureAuth(memoryAuthAdapter(), 'http://sync.test', { fetch: server.fetch });
    await expect(cycle(a)).rejects.toBeInstanceOf(SyncError);
  });
});

describe('first connection (bootstrap)', () => {
  it('the server wins over backfilled local copies; real local edits still win', async () => {
    const a = await newDevice();
    await ruleOn(a, 'COSTCO', 'Shopping');
    await ruleOn(a, 'SHELL', 'Gas');
    await cycle(a);

    // Device B already had its own copies before connecting.
    const b = await makeDevice('fungible-proto-');
    devices.push(b);
    use(b);
    await ruleOn(b, 'COSTCO', 'Misc');
    await ruleOn(b, 'SHELL', 'Misc');
    await ruleOn(b, 'LOCALONLY', 'Misc');
    await enableHostedMode({ userId: USER, client: b.client, dataDir: b.dir });
    await b.client.execute("UPDATE category_rules SET category = 'Fuel' WHERE pattern = 'SHELL'"); // a real edit after enabling
    const s = await cycle(b);
    expect(s.errors).toEqual([]);
    const cats = Object.fromEntries((await sql(b, 'SELECT pattern, category FROM category_rules')).map((r) => [r.pattern, r.category]));
    expect(cats).toEqual({ COSTCO: 'Shopping', SHELL: 'Fuel', LOCALONLY: 'Misc' });
    const serverCats = Object.fromEntries(server.liveRows(USER, 'category_rules').map((r) => [r.pattern, r.category]));
    expect(serverCats).toEqual({ COSTCO: 'Shopping', SHELL: 'Fuel', LOCALONLY: 'Misc' });
  });

  it('refuses a server that cannot hand over a cursor', async () => {
    const a = await newDevice();
    const broken: typeof fetch = async (u, init) => {
      if (String(u).includes('/sync/pull')) return new Response(JSON.stringify({ tables: {} }), { status: 200 });
      return server.fetch(u, init);
    };
    configureSync('http://sync.test', { fetch: broken });
    await expect(cycle(a)).rejects.toMatchObject({ code: 'bootstrap_no_server_seq' });
  });
});

describe('rejections', () => {
  it('conflict_unique is reported once, then counted; the server row is adopted on pull', async () => {
    const a = await newDevice();
    await cycle(a);
    // Another client (random ids) already created the same natural key.
    server.inject(USER, 'legacy', {
      op_id: 'legacy-1', tbl: 'tags', pk: { id: '11111111-1111-4111-8111-111111111111' }, kind: 'upsert',
      fields: { name: 'travel' }, hlc: formatHlc(Date.now() - 1000, 0, 'legacy'),
    });
    await a.client.execute("INSERT INTO tags (name) VALUES ('travel')");
    const s1 = await cycle(a);
    expect(s1.errors).toHaveLength(1);
    expect(s1.errors[0]).toMatchObject({ table: 'tags', reason: 'conflict_unique' });
    // Pull brought the server's row: one local tag, wearing the server's id.
    expect(await sql(a, 'SELECT name, uuid FROM tags')).toEqual([{ name: 'travel', uuid: '11111111-1111-4111-8111-111111111111' }]);

    const s2 = await cycle(a);
    expect(s2.errors).toEqual([]); // reported once
    const info = await getSyncInfo(a.client);
    expect(info.rejectedCount).toBe(1);
    expect(info.pendingCount).toBe(0);
  });

  it('row_missing keeps the op queued and retries until the row exists', async () => {
    const a = await newDevice();
    await cycle(a);
    // The local row is known to this device but not (yet) to the server.
    await a.client.execute("INSERT INTO transactions (id, account_id, date, name, amount, source) VALUES ('later', 'acc', '2026-07-01', 'X', 1, 'plaid')");
    await a.client.execute("INSERT INTO _sync_server_tx (id) VALUES ('later')");
    await a.client.execute("UPDATE transactions SET manual_category = 'Gas' WHERE id = 'later'");
    const s1 = await cycle(a);
    expect(s1.retrying).toBe(1);
    expect(s1.errors).toEqual([]);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(1);
    expect((await getSyncInfo(a.client)).rejectedCount).toBe(0);

    server.putAccount(USER, { id: 'acc', name: 'Chk', type: 'depository' });
    server.putTransaction(USER, { id: 'later', account_id: 'acc', date: '2026-07-01', name: 'X', amount: 1 });
    const s2 = await cycle(a);
    expect(s2.retrying ?? 0).toBe(0);
    expect(server.row(USER, 'transactions', { id: 'later' })).toMatchObject({ manual_category: 'Gas' });
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
  });

  it('clock skew: invalid_hlc is surfaced, never sent far-future, and recovers once anchored', async () => {
    const a = await newDevice();
    await cycle(a); // bootstrap
    server.now = () => Date.now() - 10 * 60_000; // this device's clock runs 10 min ahead
    // A peer's op carries the server's notion of "now"; pulling it anchors the device.
    server.inject(USER, 'peer', {
      op_id: 'peer-1', tbl: 'tags', pk: { id: '22222222-2222-4222-8222-222222222222' }, kind: 'upsert',
      fields: { name: 'peer-tag' }, hlc: formatHlc(server.now(), 0, 'peer'),
    });
    await cycle(a);
    await a.client.execute("INSERT INTO tags (name) VALUES ('skewed')");
    const s1 = await cycle(a);
    expect(s1.clockSkew).toBe(true);
    expect(s1.errors).toEqual([]);
    const s2 = await cycle(a);
    expect(s2.errors).toEqual([]);
    expect(server.liveRows(USER, 'tags').map((r) => r.name).sort()).toEqual(['peer-tag', 'skewed']);
    // Whatever was sent is within the server's window.
    for (const o of server.opsOf(USER)) {
      expect(Number(o.hlc.slice(0, 15) || 0)).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    }
  });

  it('settings: only the allowlist syncs, in both directions', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await a.client.execute("INSERT INTO settings (key, value) VALUES ('theme', 'dark'), ('pretax_monthly', '800')");
    await cycle(a);
    expect(server.liveRows(USER, 'settings').map((r) => r.key)).toEqual(['pretax_monthly']);
    // A server holding a stray key must not write it locally.
    const u = server.user(USER);
    u.ops.push({ server_seq: ++u.seq, op_id: 'stray', device_id: 'x', tbl: 'settings', pk: { key: 'theme' }, kind: 'upsert', fields: { value: 'neon' }, hlc: formatHlc(Date.now(), 0, 'x') });
    await cycle(b);
    const keys = (await sql(b, "SELECT key, value FROM settings WHERE key != 'device_id' ORDER BY key")).map((r) => `${r.key}=${r.value}`);
    expect(keys).toEqual(['pretax_monthly=800']);
    // device_id is local and unique per install.
    const ida = await sql(a, "SELECT value FROM settings WHERE key = 'device_id'");
    const idb = await sql(b, "SELECT value FROM settings WHERE key = 'device_id'");
    expect(ida[0].value).not.toBe(idb[0].value);
  });

  it('household members travel under per-user derived ids and map back to local slots', async () => {
    const a = await newDevice();
    const b = await newDevice();
    await a.client.execute("INSERT OR REPLACE INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Sam', 1985, 0)");
    await a.client.execute("INSERT OR REPLACE INTO household_members (id, name, birth_year, sort_order) VALUES ('child-0', 'Kit', 2019, 2)");
    await cycle(a);
    const selfId = await deriveMemberUuid(USER, 'self');
    expect(selfId).not.toBe(await deriveMemberUuid('another-user', 'self'));
    expect(server.row(USER, 'household_members', { id: selfId })).toMatchObject({ name: 'Sam', birth_year: 1985 });
    await cycle(b);
    expect(await sql(b, 'SELECT id, name FROM household_members ORDER BY id')).toEqual([
      { id: 'child-0', name: 'Kit' }, { id: 'self', name: 'Sam' },
    ]);
    // A server id this user does not derive gets a stable foreign slot.
    server.inject(USER, 'foreign', {
      op_id: 'f1', tbl: 'household_members', pk: { id: '33333333-3333-4333-8333-333333333333' }, kind: 'upsert',
      fields: { name: 'Pat', birth_year: 1990, sort_order: 5 }, hlc: formatHlc(Date.now(), 0, 'foreign'),
    });
    await cycle(b);
    expect(await sql(b, "SELECT id, name FROM household_members WHERE name = 'Pat'")).toEqual([{ id: 'child-16', name: 'Pat' }]);
  });
});

describe('capture from another process', () => {
  it('writes made by a separate process through product code are logged and pushed', async () => {
    const a = await newDevice();
    await cycle(a);
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'writer-child.ts');
    a.client.close(); // release our handle; the child opens the same file
    const r = await spawnWriter({ dataDir: a.dir, script });
    expect(r.exitCode, r.stderr).toBe(0);
    const { createClient } = await import('@libsql/client');
    a.client = createClient({ url: `file:${a.dbPath}` });
    await a.client.execute('PRAGMA foreign_keys = ON');

    const info = await getSyncInfo(a.client);
    expect(info.pendingCount).toBeGreaterThanOrEqual(4);
    const s = await cycle(a);
    expect(s.errors).toEqual([]);
    expect(server.liveRows(USER, 'tags').map((t) => t.name).sort()).toEqual(['child-renamed', 'from-child']);
    expect(server.liveRows(USER, 'category_rules').map((t) => t.pattern)).toEqual(['CHILDMART']);
  }, 30_000);
});
