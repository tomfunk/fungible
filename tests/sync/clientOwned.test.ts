import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

// Client-owned rows (CSV/manual accounts, manual transactions, manual
// balances) against FakeServer, which implements the ownership rules of
// core/SYNC_PROTOCOL.md. Layer: engine integration (real product write paths,
// real triggers, real apply path; only the network is faked).
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
import { enableHostedMode, disableHostedMode } from '../../core/sync-mode.js';
import {
  createManualAccount, createCsvAccount, updateAccountValue, updateAccountNickname, deleteAccount,
} from '../../core/accounts.js';
import { addTransaction, deleteTransaction } from '../../core/transactions.js';
import { createTag, addTagToTransaction } from '../../core/tags.js';
import { getLinkedAccounts, getAccountsWithBalances, getTransactions } from '../../core/queries.js';

const USER = 'user-1';
let server: FakeServer;
let devices: Device[];

async function device(): Promise<Device> {
  const d = await makeDevice();
  devices.push(d);
  return d;
}
const use = (d: Device) => { h.client = d.client; };
const enable = (d: Device) => enableHostedMode({ userId: USER, client: d.client, dataDir: d.dir });
const cycle = (d: Device) => { use(d); return runSyncCycle({ client: d.client }); };
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  server = new FakeServer();
  devices = [];
  connect(server, USER);
});
afterEach(() => { for (const d of devices) d.close(); });

async function twoDevices(): Promise<[Device, Device]> {
  const a = await device();
  const b = await device();
  await enable(a);
  await enable(b);
  await cycle(a);
  await cycle(b);
  return [a, b];
}

const idOf = async (d: Device, name: string): Promise<string> =>
  (await q<{ id: string }>(d.client, 'SELECT id FROM accounts WHERE name = ?', [name]))[0].id;

const accounts = (d: Device) => q<{ id: string; name: string; origin: string | null; wire_id: string | null; nickname: string | null }>(
  d.client, 'SELECT id, name, origin, wire_id, nickname FROM accounts ORDER BY name');

describe('client-owned rows: create, edit, delete propagate', () => {
  it('a manual account with transactions and a balance on A shows up everywhere on B', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Rental House', 250000);
    await addTransaction({ accountId: acct, date: '2026-03-04', name: 'Roof repair', amount: 1800.5, category: 'Home' });
    await cycle(a);

    const wire = (await accounts(a))[0].wire_id!;
    expect(wire).toMatch(/^acct-[0-9a-f-]{36}$/);
    const onServer = server.liveRows(USER, 'accounts');
    expect(onServer).toHaveLength(1);
    expect(onServer[0]).toMatchObject({ id: wire, name: 'Rental House', origin: 'client', subtype: 'manual' });

    await cycle(b);
    use(b);
    const linked = await getLinkedAccounts();
    expect(linked.map((l) => l.name)).toEqual(['Rental House']);
    // Recognised as a manual account by the existing id-prefix convention.
    expect(linked[0].id.startsWith('manual-')).toBe(true);
    const bal = await getAccountsWithBalances();
    expect(bal.accounts.find((x) => x.name === 'Rental House')).toBeTruthy();
    const txs = await q<{ name: string; amount: number; category: string; source: string; account_id: string }>(
      b.client, 'SELECT name, amount, category, source, account_id FROM transactions');
    expect(txs).toEqual([{ name: 'Roof repair', amount: 1800.5, category: 'Home', source: 'manual', account_id: linked[0].id }]);
    expect((await getTransactions({})).length).toBe(1);
    const balRows = await q<{ balance: number; date: string }>(b.client, 'SELECT balance, date FROM balance_history');
    expect(balRows).toEqual([{ balance: 250000, date: today() }]);
    // Applying a pull never echoes: B has nothing to push.
    expect((await getSyncInfo(b.client)).pendingCount).toBe(0);
    const echo = await cycle(b);
    expect(echo.pushed).toBe(0);
  });

  it('edits (nickname, transaction fields, balance) and deletes propagate', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Car', 20000);
    const tx = await addTransaction({ accountId: acct, date: '2026-04-01', name: 'Insurance', amount: 90, category: 'Insurance' });
    await cycle(a);
    await cycle(b);

    use(a);
    await updateAccountNickname(acct, 'Truck');
    await a.client.execute({ sql: 'UPDATE transactions SET name = ?, amount = ?, ignored = 1 WHERE id = ?', args: ['Insurance Q2', 95, tx] });
    await updateAccountValue(acct, 19000);
    await cycle(a);
    await cycle(b);
    use(b);
    expect((await accounts(b))[0].nickname).toBe('Truck');
    expect(await q(b.client, 'SELECT name, amount, ignored FROM transactions')).toEqual([{ name: 'Insurance Q2', amount: 95, ignored: 1 }]);
    expect((await q<{ balance: number }>(b.client, 'SELECT balance FROM balance_history'))[0].balance).toBe(19000);

    // Delete on B comes back to A.
    use(b);
    await deleteTransaction((await q<{ id: string }>(b.client, 'SELECT id FROM transactions'))[0].id);
    await cycle(b);
    await cycle(a);
    expect(await q(a.client, 'SELECT id FROM transactions')).toEqual([]);
  });

  it('deleting an account cascades; the parent delete carries no child deletes and every device converges', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Boat', 12000);
    await addTransaction({ accountId: acct, date: '2026-05-01', name: 'Fuel', amount: 60, category: 'Transportation' });
    await addTransaction({ accountId: acct, date: '2026-05-02', name: 'Dock', amount: 400, category: 'Fees' });
    await cycle(a);
    await cycle(b);
    expect(await q(b.client, 'SELECT id FROM transactions')).toHaveLength(2);

    use(a);
    await deleteAccount(acct);
    const batchesBefore = server.user(USER).batches.length;
    await cycle(a);
    const sent = server.user(USER).batches.slice(batchesBefore).flatMap((x) => x.ops);
    expect(sent.map((o) => `${o.tbl}:${o.kind}`)).toEqual(['accounts:delete']);
    // The server emitted one delete per child, with no originating device.
    const cascade = server.opsOf(USER).filter((o) => o.device_id === null);
    expect(cascade.map((o) => o.tbl).sort()).toEqual(['balance_history', 'transactions', 'transactions']);
    expect(server.liveRows(USER, 'transactions')).toEqual([]);

    // Both the originating device (cascade ops come back idempotently) and the peer converge.
    const again = await cycle(a);
    expect(again.errors).toEqual([]);
    await cycle(b);
    for (const d of [a, b]) {
      expect(await q(d.client, 'SELECT id FROM accounts')).toEqual([]);
      expect(await q(d.client, 'SELECT id FROM transactions')).toEqual([]);
      expect(await q(d.client, 'SELECT account_id FROM balance_history')).toEqual([]);
    }
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
  });

  it('wire id survives a rename and is stable across devices creating the same CSV account', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const ida = await createCsvAccount('Chase Checking', 'depository', 'checking');
    use(b);
    const idb = await createCsvAccount('chase  checking', 'depository', 'checking');
    await cycle(a);
    await cycle(b);
    await cycle(a);
    // One server row; each device keeps one local account.
    expect(server.liveRows(USER, 'accounts')).toHaveLength(1);
    expect((await accounts(a)).length).toBe(1);
    expect((await accounts(b)).length).toBe(1);
    const wireA = (await accounts(a))[0].wire_id;
    expect(wireA).toBe((await accounts(b))[0].wire_id);

    use(a);
    await a.client.execute({ sql: 'UPDATE accounts SET name = ? WHERE id = ?', args: ['Chase Main', ida] });
    await cycle(a);
    expect((await accounts(a))[0].wire_id).toBe(wireA);
    expect(server.liveRows(USER, 'accounts')).toHaveLength(1);
    expect(server.liveRows(USER, 'accounts')[0].name).toBe('Chase Main');
    void idb;
  });

  it('tag links on manual transactions sync', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Side gig', 0);
    const tx = await addTransaction({ accountId: acct, date: '2026-06-01', name: 'Invoice', amount: -500, category: 'Income' });
    await createTag('client-x');
    const tag = (await q<{ id: number }>(a.client, `SELECT id FROM tags WHERE name = 'client-x'`))[0];
    await addTagToTransaction(tx, tag.id);
    await cycle(a);
    await cycle(b);
    expect(await q(b.client, 'SELECT transaction_id FROM transaction_tags')).toEqual([{ transaction_id: tx }]);
  });
});

describe('server behaviours the client must survive', () => {
  it('a child upsert for a tombstoned account is row_missing: it stays queued and settles once the delete arrives', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Shared', 100);
    await cycle(a);
    await cycle(b);
    use(b);
    await deleteAccount(await idOf(b, 'Shared'));
    await cycle(b);

    // A has not pulled the delete yet and adds a transaction.
    use(a);
    await addTransaction({ accountId: acct, date: '2026-07-01', name: 'Late', amount: 5, category: 'Fees' });
    // Push happens before pull in a cycle: the op is refused retryably.
    const first = await cycle(a);
    expect(first.retrying).toBe(1);
    expect(first.errors).toEqual([]);
    // The pull in that same cycle applied the delete and removed the local row,
    // so the next cycle finds the op moot rather than retrying it forever.
    const second = await cycle(a);
    expect(second.retrying ?? 0).toBe(0);
    expect(second.errors).toEqual([]);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
    expect(await q(a.client, 'SELECT id FROM accounts')).toEqual([]);
  });

  it('permanent rejects are recorded once and never retried', async () => {
    const [a] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Big', 1);
    await a.client.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, source)
            VALUES ('manual-huge', ?, '2026-01-01', 'Too big', 1e13, 'Fees', 0, 'manual')`,
      args: [acct],
    });
    const first = await cycle(a);
    expect(first.errors.map((e) => e.reason)).toEqual(['invalid_amount']);
    const info = await getSyncInfo(a.client);
    expect(info.rejectedCount).toBe(1);
    expect(info.pendingCount).toBe(0);
    const before = server.user(USER).batches.length;
    const second = await cycle(a);
    expect(second.errors).toEqual([]);
    expect(server.user(USER).batches.length).toBe(before); // nothing left to send
  });

  it('Plaid-owned columns are never writable: only annotations leave the device', async () => {
    const [a] = await twoDevices();
    server.putAccount(USER, { id: 'plaid-acct', name: 'Plaid Checking', type: 'depository' });
    server.putTransaction(USER, { id: 'plaid-tx-1', account_id: 'plaid-acct', date: '2026-02-01', name: 'Coffee', amount: 4 });
    await cycle(a);
    expect((await accounts(a)).find((x) => x.id === 'plaid-acct')?.origin).toBe('plaid');
    const before = server.user(USER).batches.length;
    await a.client.execute(`UPDATE transactions SET amount = 999, name = 'hacked' WHERE id = 'plaid-tx-1'`);
    await a.client.execute(`UPDATE accounts SET name = 'renamed' WHERE id = 'plaid-acct'`);
    await cycle(a);
    expect(server.user(USER).batches.length).toBe(before);
    // The server enforces the same rule independently.
    expect(server.inject(USER, 'x', {
      op_id: 'o1', tbl: 'transactions', pk: { id: 'plaid-tx-1' }, kind: 'upsert', fields: { amount: 1 },
      hlc: `${String(Date.now()).padStart(15, '0')}-00000-x`,
    })).toBe('forbidden_owner');
    expect(server.inject(USER, 'x', {
      op_id: 'o2', tbl: 'accounts', pk: { id: 'plaid-acct' }, kind: 'upsert', fields: { name: 'z', origin: 'client' },
      hlc: `${String(Date.now()).padStart(15, '0')}-00001-x`,
    })).toBe('forbidden_owner');
  });

  it('server validates ids, owner and source', () => {
    const hlc = (n: number) => `${String(Date.now()).padStart(15, '0')}-${String(n).padStart(5, '0')}-x`;
    const inj = (op: Parameters<FakeServer['inject']>[2]) => server.inject(USER, 'x', op);
    expect(inj({ op_id: 'a', tbl: 'accounts', pk: { id: 'csv-acct-1' }, kind: 'upsert', fields: { name: 'n', type: 't', origin: 'client' }, hlc: hlc(1) })).toBe('invalid_pk');
    expect(inj({ op_id: 'b', tbl: 'accounts', pk: { id: 'acct-1' }, kind: 'upsert', fields: { name: 'n', type: 't' }, hlc: hlc(2) })).toBe('invalid_source');
    expect(inj({ op_id: 'c', tbl: 'accounts', pk: { id: 'acct-1' }, kind: 'upsert', fields: { name: 'n', type: 't', origin: 'plaid' }, hlc: hlc(3) })).toBe('forbidden_owner');
    expect(inj({ op_id: 'd', tbl: 'accounts', pk: { id: 'acct-1' }, kind: 'upsert', fields: { name: 'n', type: 't', origin: 'client' }, hlc: hlc(4) })).toBe('accepted');
    expect(inj({ op_id: 'e', tbl: 'accounts', pk: { id: 'acct-1' }, kind: 'upsert', fields: { bogus: 1 }, hlc: hlc(5) })).toBe('forbidden_field');
    const tx = (id: string, fields: Record<string, unknown>) =>
      inj({ op_id: `t-${id}-${JSON.stringify(fields).length}`, tbl: 'transactions', pk: { id }, kind: 'upsert', fields, hlc: hlc(6) });
    const base = { account_id: 'acct-1', date: '2026-01-01', name: 'x', amount: 1 };
    expect(tx('manual-1', { ...base })).toBe('invalid_source');
    expect(tx('manual-1', { ...base, source: 'plaid' })).toBe('forbidden_owner');
    expect(tx('manual-1', { ...base, source: 'csv' })).toBe('invalid_source');
    expect(tx('weird-1', { ...base, source: 'manual' })).toBe('invalid_pk');
    expect(tx('manual-1', { ...base, source: 'manual', amount: 1e13 })).toBe('invalid_amount');
    expect(tx('manual-1', { ...base, source: 'manual', amount: Infinity })).toBe('invalid_amount');
    expect(tx('manual-1', { ...base, source: 'manual', account_id: 'acct-missing' })).toBe('row_missing');
    expect(tx('manual-1', { ...base, source: 'manual', category: 'Fees' })).toBe('forbidden_field');
    expect(tx('manual-1', { ...base, source: 'manual' })).toBe('accepted');
    expect(tx('manual-1', { source: 'csv' })).toBe('invalid_source'); // owner immutable
    expect(inj({ op_id: 'bal', tbl: 'balance_history', pk: { account_id: 'acct-1', date: '2026-01-01' }, kind: 'upsert', fields: { balance: 1e13, origin: 'client' }, hlc: hlc(7) })).toBe('invalid_amount');
    expect(inj({ op_id: 'bal-noorigin', tbl: 'balance_history', pk: { account_id: 'acct-1', date: '2026-01-02' }, kind: 'upsert', fields: { balance: 1 }, hlc: hlc(9) })).toBe('invalid_source');
    expect(inj({ op_id: 'bal-ok', tbl: 'balance_history', pk: { account_id: 'acct-1', date: '2026-01-02' }, kind: 'upsert', fields: { balance: 1, origin: 'client' }, hlc: hlc(10) })).toBe('accepted');
    expect(inj({ op_id: 'bal2', tbl: 'balance_history', pk: { account_id: 'acct-none', date: '2026-01-01' }, kind: 'upsert', fields: { balance: 1, origin: 'client' }, hlc: hlc(8) })).toBe('row_missing');
  });
});

describe('boolean wire fields', () => {
  it('excluded and ignored leave the device as JSON booleans and apply back as 0/1; the server rejects 0/1', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Rental House', 1000);
    await addTransaction({ accountId: acct, date: '2026-03-04', name: 'Roof repair', amount: 10, category: 'Home' });
    await a.client.execute(`UPDATE accounts SET excluded = 1 WHERE id = '${acct}'`);
    await a.client.execute(`UPDATE transactions SET ignored = 1 WHERE account_id = '${acct}'`);
    const res = await cycle(a);
    expect(res.errors).toEqual([]);

    const sent = server.opsOf(USER).filter((o) => o.fields && ('excluded' in o.fields || 'ignored' in o.fields));
    expect(sent.length).toBeGreaterThan(0);
    for (const o of sent) {
      for (const k of ['excluded', 'ignored']) {
        if (k in o.fields!) expect(typeof o.fields![k]).toBe('boolean');
      }
    }
    expect(server.liveRows(USER, 'accounts')[0].excluded).toBe(true);
    expect(server.liveRows(USER, 'transactions')[0].ignored).toBe(true);

    await cycle(b);
    expect(await q(b.client, 'SELECT excluded FROM accounts WHERE name = ?', ['Rental House'])).toEqual([{ excluded: 1 }]);
    expect(await q(b.client, 'SELECT ignored FROM transactions')).toEqual([{ ignored: 1 }]);

    const hlc = `${String(Date.now()).padStart(15, '0')}-00000-x`;
    expect(server.inject(USER, 'x', { op_id: 'n1', tbl: 'accounts', pk: { id: 'acct-n' }, kind: 'upsert',
      fields: { name: 'n', type: 't', origin: 'client', excluded: 0 }, hlc })).toBe('forbidden_field');
    expect(server.inject(USER, 'x', { op_id: 'n2', tbl: 'transactions', pk: { id: 'manual-n' }, kind: 'upsert',
      fields: { ignored: 1 }, hlc })).toBe('forbidden_field');
  });
});

describe('tag link deletes', () => {
  it('deleting a tagged manual transaction removes the link on the other device', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Tagged', 1);
    const tx = await addTransaction({ accountId: acct, date: '2026-06-01', name: 'Invoice', amount: 5, category: 'Fees' });
    await createTag('t1');
    const tag = (await q<{ id: number }>(a.client, `SELECT id FROM tags WHERE name = 't1'`))[0];
    await addTagToTransaction(tx, tag.id);
    await cycle(a);
    await cycle(b);
    expect(await q(b.client, 'SELECT * FROM transaction_tags')).toHaveLength(1);
    use(a);
    await deleteTransaction(tx);
    const r = await cycle(a);
    expect(r.errors).toEqual([]);
    expect(server.liveRows(USER, 'transaction_tags')).toHaveLength(0);
    await cycle(b);
    expect(await q(b.client, 'SELECT * FROM transaction_tags')).toEqual([]);
    expect(await q(b.client, 'SELECT id FROM transactions')).toEqual([]);
  });

  it('deleting an account sends explicit link deletes for its children (the server does not cascade links)', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Tagged acct', 1);
    await createTag('t2');
    const tag = (await q<{ id: number }>(a.client, `SELECT id FROM tags WHERE name = 't2'`))[0];
    for (const n of ['x', 'y']) {
      const tx = await addTransaction({ accountId: acct, date: '2026-06-02', name: n, amount: 5, category: 'Fees' });
      await addTagToTransaction(tx, tag.id);
    }
    await cycle(a);
    await cycle(b);
    expect(server.liveRows(USER, 'transaction_tags')).toHaveLength(2);
    use(a);
    await deleteAccount(acct);
    const r = await cycle(a);
    expect(r.errors).toEqual([]);
    expect(server.liveRows(USER, 'transaction_tags')).toHaveLength(0);
    await cycle(b);
    expect(await q(b.client, 'SELECT * FROM transaction_tags')).toEqual([]);
    expect(await q(b.client, 'SELECT id FROM accounts')).toEqual([]);
  });
});

describe('ordering, volume, kill and resume', () => {
  it('a transaction queued before its account still lands (parents first)', async () => {
    const [a, b] = await twoDevices();
    use(a);
    // Child first, parent second: seq order is the wrong way round.
    await a.client.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, source)
            VALUES ('manual-early', 'manual-late-acct', '2026-01-02', 'Early bird', 12, 'Fees', 0, 'manual')`,
    });
    await a.client.execute(`INSERT INTO accounts (id, name, type, subtype) VALUES ('manual-late-acct', 'Late acct', 'other', 'manual')`);
    const stats = await cycle(a);
    expect(stats.errors).toEqual([]);
    expect(stats.retrying ?? 0).toBe(0);
    await cycle(b);
    expect(await q(b.client, 'SELECT name FROM transactions')).toEqual([{ name: 'Early bird' }]);
  });

  it('enable backfills existing local client rows with parents first, after the snapshot', async () => {
    const d = await device();
    use(d);
    const acct = await createManualAccount('Pre-existing', 700);
    await addTransaction({ accountId: acct, date: '2026-01-05', name: 'Old', amount: 7, category: 'Fees' });
    await d.client.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, source, dedup_key)
       VALUES ('csv-1-0', ?, '2026-01-06', 'From CSV', 3, 'Fees', 0, 'csv', 'k')`, [acct] as never);
    await enable(d);
    const ops = await q<{ tbl: string; origin: string }>(d.client, `SELECT tbl, origin FROM _oplog WHERE tbl IN ('accounts','transactions','balance_history') ORDER BY seq`);
    expect(ops.map((o) => o.tbl)).toEqual(['accounts', 'transactions', 'balance_history']);
    expect(ops.every((o) => o.origin === 'backfill')).toBe(true);
    expect((await accounts(d))[0].origin).toBe('client');

    const stats = await cycle(d);
    expect(stats.errors).toEqual([]);
    expect(server.liveRows(USER, 'transactions').map((t) => t.name)).toEqual(['Old']);
    // CSV rows are local-only until their ids are derivable; say so.
    const info = await getSyncInfo(d.client);
    expect(info.localOnlyCount).toBe(1);
    expect(info.heldCount).toBeGreaterThanOrEqual(0);
  });

  it('5k rows: <=500 per batch, killed mid-push, resumes without duplicates', { timeout: 120_000 }, async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Bulk', 0);
    const stmts = [];
    for (let i = 0; i < 5000; i++) {
      stmts.push({
        sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, source)
              VALUES (?, ?, '2026-02-01', ?, ?, 'Fees', 0, 'manual')`,
        args: [`manual-bulk-${i}`, acct, `Row ${i}`, i + 1],
      });
    }
    await a.client.batch(stmts, 'write');

    server.postBudget = 4; // die after four batches
    await expect(cycle(a)).rejects.toMatchObject({ code: 'push_failed' });
    const partial = server.liveRows(USER, 'transactions').length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(5000);
    const pending = (await getSyncInfo(a.client)).pendingCount;
    expect(pending).toBeGreaterThan(0);

    server.postBudget = null;
    const ok = await cycle(a);
    expect(ok.errors).toEqual([]);
    expect(server.liveRows(USER, 'transactions')).toHaveLength(5000);
    const sizes = server.user(USER).batches.map((x) => x.ops.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);

    await cycle(b);
    expect(await q(b.client, 'SELECT COUNT(*) AS n FROM transactions')).toEqual([{ n: 5000 }]);
  });

  it('a resync (410) removes client rows deleted elsewhere, keeps rows with pending edits', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const keep = await createManualAccount('Keep', 1);
    const gone = await createManualAccount('Gone', 2);
    await cycle(a);
    await cycle(b);
    // B goes offline; A deletes one account.
    use(a);
    await deleteAccount(gone);
    await cycle(a);
    server.compact(USER, server.user(USER).seq);
    // B has a pending local edit on the kept account.
    use(b);
    await updateAccountNickname(await idOf(b, 'Keep'), 'still mine');
    void keep;
    const stats = await cycle(b);
    expect(stats.resynced).toBe(true);
    const names = (await accounts(b)).map((x) => x.name);
    expect(names).toEqual(['Keep']);
    expect(server.liveRows(USER, 'accounts').find((r) => r.name === 'Keep')?.nickname).toBe('still mine');
  });
});

describe('adoption of client accounts', () => {
  it('an unpushed CSV/manual account matching a pulled Plaid account is adopted, not duplicated', async () => {
    const d = await device();
    use(d);
    await d.client.execute(
      `INSERT INTO accounts (id, name, type, subtype, institution_name) VALUES ('csv-acct-1', 'Everyday Checking', 'depository', 'checking', 'Example Bank')`);
    await d.client.execute(
      `INSERT INTO accounts (id, name, type, subtype, institution_name) VALUES ('csv-acct-2', 'Totally Different', 'depository', 'checking', 'Other Bank')`);
    await d.client.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, source)
       VALUES ('manual-1', 'csv-acct-1', '2026-01-02', 'Cash tip', 20, 'Fees', 0, 'manual')`);
    await enableHostedMode({ userId: USER, client: d.client, snapshot: false });
    server.putAccount(USER, { id: 'S-chk', name: 'Everyday Checking', type: 'depository', subtype: 'checking', institution_name: 'Example Bank' });
    const stats = await cycle(d);
    expect(stats.byokAdopted?.accounts).toBe(1);
    const accts = await accounts(d);
    expect(accts.map((a) => a.id).sort()).toEqual(['S-chk', 'csv-acct-2']);
    expect(accts.find((a) => a.id === 'S-chk')?.origin).toBe('plaid');
    // The manual transaction follows the account and still syncs, on the Plaid account.
    expect(await q(d.client, `SELECT account_id FROM transactions WHERE id = 'manual-1'`)).toEqual([{ account_id: 'S-chk' }]);
    const tx = server.liveRows(USER, 'transactions').find((t) => t.id === 'manual-1');
    expect(tx).toMatchObject({ account_id: 'S-chk', source: 'manual' });
    // Only the unmatched client account was pushed as a client account.
    expect(server.liveRows(USER, 'accounts').filter((a) => String(a.id).startsWith('acct-'))).toHaveLength(1);
  });
});

describe('modes', () => {
  it('BYOK stays inert: no columns, triggers or ops for client rows', async () => {
    const d = await device();
    use(d);
    const acct = await createManualAccount('Plain', 5);
    await addTransaction({ accountId: acct, date: '2026-01-01', name: 'x', amount: 1, category: 'Fees' });
    await deleteAccount(acct);
    const cols = await q<{ name: string }>(d.client, `PRAGMA table_info(accounts)`);
    expect(cols.map((c) => c.name)).not.toContain('origin');
    expect(cols.map((c) => c.name)).not.toContain('wire_id');
    const trig = await q(d.client, `SELECT name FROM sqlite_master WHERE type = 'trigger'`);
    expect(trig).toEqual([]);
    const stats = await runSyncCycle({ client: d.client });
    expect(stats.inert).toBe('byok');
    expect(server.requests).toHaveLength(0);
  });

  it('round trip: edits made while back in BYOK push on re-enable', async () => {
    const [a, b] = await twoDevices();
    use(a);
    const acct = await createManualAccount('Roundtrip', 10);
    await cycle(a);
    await disableHostedMode(a.client);
    await addTransaction({ accountId: acct, date: '2026-08-01', name: 'While byok', amount: 9, category: 'Fees' });
    await updateAccountNickname(acct, 'edited offline');
    expect((await runSyncCycle({ client: a.client })).inert).toBe('byok');
    await enableHostedMode({ userId: USER, client: a.client, dataDir: a.dir });
    await cycle(a);
    await cycle(b);
    use(b);
    expect((await accounts(b))[0].nickname).toBe('edited offline');
    expect(await q(b.client, 'SELECT name FROM transactions')).toEqual([{ name: 'While byok' }]);
  });
});
