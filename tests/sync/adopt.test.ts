// BYOK -> hosted adoption: local Plaid-era rows meet their server twins.
// Ported from the older engine's suite; fixtures are synthetic (invented
// institutions and amounts), the server is the in-memory protocol fake.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

import { makeDevice, connect, q, type Device } from './harness.js';
import { FakeServer } from './fakeServer.js';
import { runSyncCycle, getSyncInfo } from '../../core/sync-client.js';
import { enableHostedMode, disableHostedMode, resetForNewAccount } from '../../core/sync-mode.js';
import { formatHlc } from '../../core/hlc.js';

const USER = 'user-1';
let server: FakeServer;
let d: Device;
let snaps: string[];

beforeEach(async () => {
  server = new FakeServer();
  connect(server, USER);
  d = await makeDevice('fungible-adopt-');
  h.client = d.client;
  snaps = [];
  await enableHostedMode({
    userId: USER, client: d.client,
    snapshot: async (reason) => { snaps.push(reason); },
  });
});
afterEach(() => d.close());

const cycle = () => runSyncCycle({ client: d.client });
const sql = (s: string, a: (string | number)[] = []) => q(d.client, s, a);

async function localAccount(id: string, name: string, type: string, mask: string | null): Promise<void> {
  await d.client.execute({
    sql: `INSERT INTO accounts (id, name, type, institution_name, mask, nickname, item_id) VALUES (?, ?, ?, 'Example Bank', ?, ?, ?)`,
    args: [id, name, type, mask, `nick-${id}`, 'item-1'],
  });
}
async function localTx(id: string, acct: string, date: string, name: string, amount: number, extra: Record<string, unknown> = {}): Promise<void> {
  const c = { manual_category: null, display_name: null, ignored: 0, source: 'plaid', ...extra };
  await d.client.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, manual_category, display_name, ignored, source) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, acct, date, name, amount, c.manual_category as string | null, c.display_name as string | null, c.ignored as number, c.source as string],
  });
}
const srvAcct = (id: string, name: string, type: string, mask: string | null) =>
  server.putAccount(USER, { id, name, type, subtype: null, institution_name: 'Example Bank', mask });
const srvTx = (id: string, acct: string, date: string, name: string, amount: number) =>
  server.putTransaction(USER, { id, account_id: acct, date, name, amount });
const annotate = (id: string, fields: Record<string, unknown>) =>
  server.inject(USER, 'other-device', {
    op_id: `ann-${id}-${Object.keys(fields).join('')}`, tbl: 'transactions', pk: { id }, kind: 'upsert', fields,
    hlc: formatHlc(Date.now() + 1000, 0, 'other-device'),
  });

async function baseFixture(): Promise<void> {
  await localAccount('old-chk', 'Checking', 'depository', '1234');
  await localAccount('old-card', 'Card', 'credit', '5678');
  await localTx('old-1', 'old-chk', '2026-07-01', 'WHOLE FOODS #123', 50);
  await localTx('old-2', 'old-chk', '2026-07-02', 'SHELL OIL', 40, { manual_category: 'Gas' });
  await localTx('old-3', 'old-chk', '2026-07-05', 'Venmo', 20, { ignored: 1 });
  // double coffee: two real $5 on the same day, Plaid reports both
  await localTx('old-c1', 'old-card', '2026-07-03', 'Starbucks Store 1182', 5);
  await localTx('old-c2', 'old-card', '2026-07-03', 'Starbucks Store 1182', 5, { manual_category: 'Coffee' });
  await localTx('old-far', 'old-card', '2026-06-01', 'Netflix', 15); // outside the 3-day window
  await localTx('csv-1', 'old-chk', '2026-07-01', 'Whole Foods Market', 51.5, { source: 'csv' });
  await d.client.execute(`INSERT INTO accounts (id, name, type, institution_name) VALUES ('csv-acct', 'Old Savings', 'depository', 'Credit Union')`);
  await localTx('csv-2', 'csv-acct', '2026-07-01', 'Interest', -1, { source: 'csv' });
  await d.client.execute(`INSERT INTO tags (name) VALUES ('groceries')`);
  await d.client.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('old-1', 1)`);
  await d.client.execute(`INSERT INTO category_rules (priority, match_type, pattern, category, account_id) VALUES (10, 'name', 'X', 'Y', 'old-chk')`);

  srvAcct('S-chk', 'Everyday Checking', 'depository', '1234');
  srvAcct('S-card', 'Rewards Card', 'credit', '5678');
  srvTx('S-1', 'S-chk', '2026-07-02', 'Whole Foods Market', 50); // date shifted by 1, name contains
  srvTx('S-2', 'S-chk', '2026-07-02', 'Shell Oil 5733', 40);
  srvTx('S-3', 'S-chk', '2026-07-05', 'Venmo', 20);
  srvTx('S-c1', 'S-card', '2026-07-03', 'Starbucks Store 1182', 5);
  srvTx('S-c2', 'S-card', '2026-07-04', 'Starbucks Store 1182', 5);
  srvTx('S-only', 'S-chk', '2026-07-06', 'Brand New Merchant', 9); // no local twin
}

describe('BYOK adoption', () => {
  it('re-keys matched accounts and transactions, carries annotations and tags, keeps the rest local', async () => {
    await baseFixture();
    const s = await cycle();
    expect(s.byokAdopted).toEqual({ accounts: 2, transactions: 5 });

    const accts = await sql('SELECT id, name, nickname FROM accounts ORDER BY id');
    expect(accts.map((a) => a.id)).toEqual(['S-card', 'S-chk', 'csv-acct']);
    expect(accts.find((a) => a.id === 'S-chk')).toMatchObject({ name: 'Everyday Checking', nickname: 'nick-old-chk' });
    expect((await sql(`SELECT account_id FROM category_rules WHERE pattern = 'X'`))[0].account_id).toBe('S-chk');

    const ids = (await sql('SELECT id FROM transactions ORDER BY id')).map((r) => r.id);
    expect(ids).toEqual(['S-1', 'S-2', 'S-3', 'S-c1', 'S-c2', 'S-only', 'csv-1', 'csv-2', 'old-far'].sort());
    // the double coffee stayed two rows and the annotated one kept its annotation
    const coffees = await sql(`SELECT id, manual_category FROM transactions WHERE id IN ('S-c1','S-c2') ORDER BY id`);
    expect(coffees).toEqual([{ id: 'S-c1', manual_category: null }, { id: 'S-c2', manual_category: 'Coffee' }]);
    expect((await sql(`SELECT manual_category FROM transactions WHERE id = 'S-2'`))[0].manual_category).toBe('Gas');
    expect((await sql(`SELECT ignored FROM transactions WHERE id = 'S-3'`))[0].ignored).toBe(1);
    // the tag link followed the row
    expect(await sql(`SELECT transaction_id FROM transaction_tags`)).toEqual([{ transaction_id: 'S-1' }]);
    // unmatched local rows stay local
    expect((await sql(`SELECT source FROM transactions WHERE id = 'csv-1'`))[0].source).toBe('csv');
    expect(await sql(`SELECT id FROM transactions WHERE id = 'old-far'`)).toHaveLength(1);
  });

  it('pushes exactly the moved annotations and the tag link, never local-only rows', async () => {
    await baseFixture();
    await d.client.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('old-far', 1)`);
    await cycle();

    for (const [id, f] of [
      ['S-2', { manual_category: 'Gas' }], ['S-3', { ignored: 1 }], ['S-c2', { manual_category: 'Coffee' }],
    ] as const) {
      expect(server.row(USER, 'transactions', { id })).toMatchObject(f);
    }
    expect(server.row(USER, 'transactions', { id: 'S-1' })).toEqual({}); // nothing annotated there
    // no op ever addressed a local-only transaction
    const sent = server.opsOf(USER).filter((o) => o.kind !== 'server_upsert' && (o.tbl === 'transactions' || o.tbl === 'transaction_tags'));
    const txIds = sent.filter((o) => o.tbl === 'transactions').map((o) => o.pk.id).sort();
    expect(txIds).toEqual(['S-2', 'S-3', 'S-c2']);
    const linkTx = sent.filter((o) => o.tbl === 'transaction_tags').map((o) => o.pk.transaction_id);
    expect(linkTx).toEqual(['S-1']);

    // Held-back links on local-only rows do not read as pending work.
    const info = await getSyncInfo(d.client);
    expect(info.pendingCount).toBe(0);
    expect(info.heldCount).toBeGreaterThan(0);
  });

  it('server annotations win over local ones', async () => {
    await baseFixture();
    annotate('S-2', { manual_category: 'Auto' });
    await cycle();
    expect((await sql(`SELECT manual_category FROM transactions WHERE id = 'S-2'`))[0].manual_category).toBe('Auto');
    expect(server.row(USER, 'transactions', { id: 'S-2' })).toMatchObject({ manual_category: 'Auto' });
  });

  it('is idempotent: a second cycle over the same data changes nothing', async () => {
    await baseFixture();
    await cycle();
    const snap = async () => JSON.stringify([
      await sql('SELECT * FROM transactions ORDER BY id'), await sql('SELECT * FROM accounts ORDER BY id'),
      await sql('SELECT * FROM transaction_tags'),
    ]);
    const before = await snap();
    const again = await cycle();
    expect(again.byokAdopted).toBeUndefined();
    expect(await snap()).toBe(before);
  });

  it('survives BYOK <-> hosted toggles: late server rows still match, refreshed accounts merge', async () => {
    await baseFixture();
    await cycle();
    await disableHostedMode(d.client);
    // BYOK-era activity: the old Plaid link re-creates the account under its old id with a new row
    await localAccount('old-chk', 'Checking', 'depository', '1234');
    await localTx('old-late', 'old-chk', '2026-07-10', 'CVS PHARMACY', 12);
    await enableHostedMode({ userId: USER, client: d.client, snapshot: async () => {} });
    srvTx('S-late', 'S-chk', '2026-07-10', 'CVS/PHARMACY #1042', 12);
    const s = await cycle();
    expect(s.byokAdopted).toEqual({ accounts: 0, transactions: 1 });
    expect((await sql(`SELECT id FROM accounts WHERE institution_name = 'Example Bank' ORDER BY id`)).map((r) => r.id)).toEqual(['S-card', 'S-chk']);
    expect((await sql(`SELECT id, account_id FROM transactions WHERE id = 'S-late'`))[0]).toEqual({ id: 'S-late', account_id: 'S-chk' });
    expect(await sql(`SELECT id FROM transactions WHERE id = 'old-late'`)).toEqual([]);
  });

  it('server rows arriving later re-evaluate previously unmatched local rows', async () => {
    await baseFixture();
    await cycle();
    expect(await sql(`SELECT id FROM transactions WHERE id = 'old-far'`)).toHaveLength(1);
    srvTx('S-far', 'S-card', '2026-06-01', 'Netflix', 15);
    const s = await cycle();
    expect(s.byokAdopted?.transactions).toBe(1);
    expect(await sql(`SELECT id FROM transactions WHERE id = 'old-far'`)).toEqual([]);
  });

  it('does not guess when a mask is missing and the name is ambiguous', async () => {
    await localAccount('a1', 'Checking', 'depository', null);
    await localAccount('a2', 'Checking', 'depository', null);
    await localTx('t1', 'a1', '2026-07-01', 'X', 1);
    srvAcct('S1', 'Checking', 'depository', null);
    srvTx('S-t', 'S1', '2026-07-01', 'X', 1);
    const s = await cycle();
    expect(s.byokAdopted).toBeUndefined();
    expect((await sql(`SELECT id FROM accounts ORDER BY id`)).map((r) => r.id)).toEqual(['S1', 'a1', 'a2']);
  });

  it('snapshots once, before the first id rewrite', async () => {
    await baseFixture();
    await cycle();
    srvTx('S-far', 'S-card', '2026-06-01', 'Netflix', 15);
    await cycle();
    expect(snaps.filter((r) => r === 'pre-adopt-sync')).toHaveLength(1);
  });

  it('a failing pre-adoption snapshot aborts before any id is rewritten', async () => {
    await enableHostedMode({ userId: USER, client: d.client, snapshot: async (r) => { if (r === 'pre-adopt-sync') throw new Error('no space'); } });
    await baseFixture();
    await expect(cycle()).rejects.toThrow(/no space/);
    expect((await sql('SELECT id FROM accounts ORDER BY id')).map((r) => r.id)).toEqual(['csv-acct', 'old-card', 'old-chk']);
    expect(await sql(`SELECT id FROM transactions WHERE id = 'old-1'`)).toHaveLength(1);
  });

  it('account reset clears the account map; a BYOK database never adopts', async () => {
    await baseFixture();
    await cycle();
    expect((await sql(`SELECT key FROM _sync_state WHERE key LIKE 'account_map:%'`)).length).toBe(2);
    await resetForNewAccount(d.client);
    expect(await sql(`SELECT key FROM _sync_state WHERE key LIKE 'account_map:%'`)).toEqual([]);

    const byok = await makeDevice('fungible-adopt-byok-');
    try {
      await byok.client.execute(`INSERT INTO accounts (id, name, type, institution_name, mask) VALUES ('old-chk', 'Checking', 'depository', 'Example Bank', '1234')`);
      const res = await runSyncCycle({ client: byok.client });
      expect(res.inert).toBe('byok');
      expect((await q(byok.client, 'SELECT id FROM accounts')).map((r) => r.id)).toEqual(['old-chk']);
    } finally { byok.close(); }
  });

  it('matches Plaid-synced accounts whose institution lives only on plaid_items', async () => {
    // Real BYOK shape: sync.ts never writes accounts.institution_name.
    await d.client.execute(`INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item-1', 'tok', 'Example Bank')`);
    await d.client.execute(`INSERT INTO accounts (id, name, type, subtype, mask, item_id) VALUES ('p-chk', 'Checking', 'depository', 'checking', '1234', 'item-1')`);
    await d.client.execute(`INSERT INTO accounts (id, name, type, subtype, mask, item_id) VALUES ('p-nomask', 'Savings', 'depository', 'savings', NULL, 'item-1')`);
    await localTx('p-1', 'p-chk', '2026-07-01', 'Whole Foods', 50);
    srvAcct('S-chk', 'Everyday Checking', 'depository', '1234');
    srvAcct('S-sav', 'Savings', 'depository', null);
    srvTx('S-1', 'S-chk', '2026-07-01', 'Whole Foods', 50);
    const s = await cycle();
    expect(s.byokAdopted).toEqual({ accounts: 2, transactions: 1 });
    expect((await sql('SELECT id FROM accounts ORDER BY id')).map((a) => a.id)).toEqual(['S-chk', 'S-sav']);
    expect((await sql('SELECT id FROM transactions')).map((r) => r.id)).toEqual(['S-1']);
  });

  describe('CSV rows vs pulled server rows', () => {
    it('folds a CSV row into its server twin, keeps annotations, keeps genuine repeats', async () => {
      await localAccount('old-chk', 'Checking', 'depository', '1234');
      // same real purchase imported from CSV (annotated), plus an unrelated CSV row
      await localTx('csv-a', 'old-chk', '2026-07-10', 'Costco', 80, { source: 'csv', manual_category: 'Groceries', ignored: 0 });
      await localTx('csv-b', 'old-chk', '2026-07-11', 'Local Bakery', 12, { source: 'csv' });
      // two real $5 coffees on CSV, the bank reports only one so far
      await localTx('csv-c1', 'old-chk', '2026-07-12', 'Blue Bottle', 5, { source: 'csv' });
      await localTx('csv-c2', 'old-chk', '2026-07-12', 'Blue Bottle', 5, { source: 'csv' });
      srvAcct('S-chk', 'Everyday Checking', 'depository', '1234');
      srvTx('S-costco', 'S-chk', '2026-07-10', 'COSTCO WHSE', 80);
      srvTx('S-coffee', 'S-chk', '2026-07-12', 'Blue Bottle', 5);
      await cycle();

      const ids = (await sql('SELECT id FROM transactions ORDER BY id')).map((r) => r.id);
      // csv-a folded into S-costco; one coffee absorbed; the repeat and the bakery survive
      expect(ids).toEqual(['S-coffee', 'S-costco', 'csv-b', 'csv-c2']);
      expect((await sql(`SELECT manual_category FROM transactions WHERE id = 'S-costco'`))[0].manual_category).toBe('Groceries');
      // the transferred annotation reaches the server against the server id
      await cycle();
      expect(server.row(USER, 'transactions', { id: 'S-costco' })).toMatchObject({ manual_category: 'Groceries' });

      // idempotent: another cycle changes nothing
      await cycle();
      expect((await sql('SELECT id FROM transactions ORDER BY id')).map((r) => r.id)).toEqual(ids);
    });

    it('does nothing in BYOK mode', async () => {
      await disableHostedMode(d.client);
      await localAccount('old-chk', 'Checking', 'depository', '1234');
      await localTx('csv-a', 'old-chk', '2026-07-10', 'Costco', 80, { source: 'csv' });
      await localTx('p-a', 'old-chk', '2026-07-10', 'Costco', 80);
      const s = await cycle();
      expect(s.inert).toBe('byok');
      expect(await sql('SELECT id FROM transactions')).toHaveLength(2);
    });
  });
});
