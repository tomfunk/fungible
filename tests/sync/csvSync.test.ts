import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Client } from '@libsql/client';

// CSV rows and imports syncing as client-owned rows: derived ids, the one-time
// re-key of legacy `csv-<importId>-<row>` ids, cross-device convergence and
// undo-import. Layer: engine integration against FakeServer (real importer,
// triggers and apply path).
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
import { enableHostedMode } from '../../core/sync-mode.js';
import { createCsvAccount, importCsvTransactions, type ImportConfig } from '../../core/accounts.js';
import { deleteImport, getImports } from '../../core/imports.js';
import { createTag, addTagToTransaction } from '../../core/tags.js';
import { isDerivedCsvId } from '../../core/sync-spec.js';
import { listSnapshots, snapshot } from '../../core/snapshot.js';
import { pairCandidates } from '../../core/dedup.js';
import { deriveAccountWireId } from '../../core/sync-ids.js';

const USER = 'user-1';
let server: FakeServer;
let devices: Device[];

const CFG: ImportConfig = {
  amountMode: 'single', dateCol: 0, nameCol: 1, amountCol: 2, debitCol: null, creditCol: null, positiveIsInflow: false,
};
async function device(): Promise<Device> {
  const d = await makeDevice();
  devices.push(d);
  return d;
}
const use = (d: Device) => { h.client = d.client; };
const enable = (d: Device) => enableHostedMode({
  userId: USER, client: d.client, dataDir: d.dir,
  snapshot: (reason) => snapshot(reason, { client: d.client, dataDir: d.dir }),
});
const cycle = (d: Device) => { use(d); return runSyncCycle({ client: d.client }); };
const idOf = async (d: Device, name: string) =>
  (await q<{ id: string }>(d.client, 'SELECT id FROM accounts WHERE name = ?', [name]))[0].id;
const txs = (d: Device) => q<{ id: string; name: string; date: string; amount: number; dedup_key: string; import_id: number | null }>(
  d.client, 'SELECT id, name, date, amount, dedup_key, import_id FROM transactions ORDER BY date, dedup_key');

beforeEach(() => {
  server = new FakeServer();
  devices = [];
  connect(server, USER);
});
afterEach(() => { for (const d of devices) d.close(); });

const FILE = [
  ['2026-01-02', 'COFFEE SHOP', '4.50'],
  ['2026-01-02', 'COFFEE SHOP', '4.50'], // identical same-day row: per-file ordinal keeps both
  ['2026-01-03', 'GROCERY', '52.10'],
];

async function importFile(d: Device, accountId: string, rows: string[][], hash: string, name = 'jan.csv') {
  use(d);
  return importCsvTransactions(rows, accountId, CFG, { name, hash });
}

describe('CSV rows and imports sync', () => {
  it('a pre-existing local import is re-keyed to derived ids behind a snapshot; children follow', async () => {
    const a = await device();
    use(a);
    const acct = await createCsvAccount('Chase Checking', 'depository', 'checking');
    await importFile(a, acct, FILE, 'hash-jan');
    const legacy = await txs(a);
    expect(legacy.every((t) => /^csv-\d+-\d+$/.test(t.id))).toBe(true);
    await createTag('food');
    const tag = (await q<{ id: number }>(a.client, `SELECT id FROM tags WHERE name = 'food'`))[0];
    await addTagToTransaction(legacy[0].id, tag.id);

    await enable(a);
    expect((await getSyncInfo(a.client)).localOnlyCount).toBe(3);
    const stats = await cycle(a);
    expect(stats.errors).toEqual([]);

    const after = await txs(a);
    expect(after.every((t) => isDerivedCsvId(t.id))).toBe(true);
    expect(new Set(after.map((t) => t.id)).size).toBe(3);
    // The tag link followed the re-key and was synced.
    const link = await q<{ transaction_id: string }>(a.client, 'SELECT transaction_id FROM transaction_tags');
    expect(link).toEqual([{ transaction_id: after.find((t) => t.dedup_key === legacy[0].dedup_key)!.id }]);
    expect(server.liveRows(USER, 'transaction_tags')).toHaveLength(1);
    expect(listSnapshots(a.dir).map((s) => s.manifest.reason)).toContain('pre-adopt-sync');
    expect((await getSyncInfo(a.client)).localOnlyCount).toBe(0);
    expect(server.liveRows(USER, 'imports')).toHaveLength(1);
    expect(server.liveRows(USER, 'transactions')).toHaveLength(3);
  });

  it('a second device receives the same ids, import and counts', async () => {
    const a = await device();
    const b = await device();
    await enable(a);
    await enable(b);
    use(a);
    const acct = await createCsvAccount('Chase Checking', 'depository', 'checking');
    await importFile(a, acct, FILE, 'hash-jan');
    await cycle(a);
    await cycle(b);
    const ta = await txs(a);
    const tb = await txs(b);
    expect(tb.map((t) => t.id)).toEqual(ta.map((t) => t.id));
    expect(tb).toHaveLength(3);
    use(b);
    const imports = await getImports();
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ file_name: 'jan.csv', row_count: 3, present: 3 });
    // Rows are linked to the pulled import record.
    expect(tb.every((t) => t.import_id === imports[0].id)).toBe(true);
    expect((await cycle(b)).pushed).toBe(0);
  });

  it('two devices importing the same file converge: same ids, no duplicates', async () => {
    const a = await device();
    const b = await device();
    await enable(a);
    await enable(b);
    const acctA = await (async () => { use(a); return createCsvAccount('Chase Checking', 'depository', 'checking'); })();
    const acctB = await (async () => { use(b); return createCsvAccount('Chase Checking', 'depository', 'checking'); })();
    await importFile(a, acctA, FILE, 'hash-jan');
    await importFile(b, acctB, FILE, 'hash-jan');
    await cycle(a);
    await cycle(b);
    await cycle(a);
    const ta = await txs(a);
    const tb = await txs(b);
    expect(ta).toHaveLength(3);
    expect(tb.map((t) => t.id)).toEqual(ta.map((t) => t.id));
    expect(server.liveRows(USER, 'transactions')).toHaveLength(3);
    expect(server.liveRows(USER, 'imports')).toHaveLength(1);
    expect(server.liveRows(USER, 'accounts')).toHaveLength(1);
    expect((await getSyncInfo(a.client)).rejectedCount).toBe(0);
    expect((await getSyncInfo(b.client)).rejectedCount).toBe(0);
  });

  it('overlapping statements dedup exactly as before and stay in sync', async () => {
    const a = await device();
    const b = await device();
    await enable(a);
    await enable(b);
    use(a);
    const acct = await createCsvAccount('Card', 'credit', null);
    const first = await importFile(a, acct, FILE, 'h1', 'jan1.csv');
    const second = await importFile(a, acct, [...FILE, ['2026-01-04', 'GAS', '30.00']], 'h2', 'jan2.csv');
    expect(first.imported).toBe(3);
    expect(second.imported).toBe(1); // the overlap is skipped, as it always was
    await cycle(a);
    await cycle(b);
    expect(await txs(b)).toHaveLength(4);
    expect(server.liveRows(USER, 'imports')).toHaveLength(2);
  });

  it('undo import propagates to the other device', async () => {
    const a = await device();
    const b = await device();
    await enable(a);
    await enable(b);
    use(a);
    const acct = await createCsvAccount('Chase Checking', 'depository', 'checking');
    const r = await importFile(a, acct, FILE, 'hash-jan');
    await cycle(a);
    await cycle(b);
    expect(await txs(b)).toHaveLength(3);

    use(a);
    expect(await deleteImport(r.importId)).toBe(3);
    const stats = await cycle(a);
    expect(stats.errors).toEqual([]);
    expect(server.liveRows(USER, 'transactions')).toHaveLength(0);
    expect(server.liveRows(USER, 'imports')).toHaveLength(0);
    await cycle(b);
    expect(await txs(b)).toEqual([]);
    expect(await q(b.client, 'SELECT id FROM imports')).toEqual([]);
    expect((await getSyncInfo(b.client)).pendingCount).toBe(0);
  });

  it('a row whose (account, dedup key) the server already holds under another id adopts that id', async () => {
    const a = await device();
    use(a);
    const acct = await createCsvAccount('Chase Checking', 'depository', 'checking');
    await importFile(a, acct, [FILE[2]], 'hash-1');
    const mine = (await txs(a))[0];
    await enable(a);
    // Another client already synced the same real row under an id it derived differently.
    const wire = await deriveAccountWireId(USER, { name: 'Chase Checking', type: 'depository', subtype: 'checking' });
    const hlc = (n: number) => `${String(Date.now()).padStart(15, '0')}-${String(n).padStart(5, '0')}-foreign`;
    expect(server.inject(USER, 'foreign', {
      op_id: 'f-acct', tbl: 'accounts', pk: { id: wire }, kind: 'upsert',
      fields: { name: 'Chase Checking', type: 'depository', subtype: 'checking', origin: 'client' }, hlc: hlc(0),
    })).toBe('accepted');
    const foreign = 'csv-00000000-0000-5000-8000-000000000001';
    expect(server.inject(USER, 'foreign', {
      op_id: 'f-tx', tbl: 'transactions', pk: { id: foreign }, kind: 'upsert',
      fields: {
        account_id: wire, date: '2026-01-03', name: 'GROCERY', amount: 52.1, source: 'csv',
        dedup_key: mine.dedup_key, manual_category: 'Grocery',
      },
      hlc: hlc(1),
    })).toBe('accepted');

    const stats = await cycle(a);
    // The snapshot brought the server's row first: ours is the same transaction,
    // takes its id, and nothing is refused.
    expect(stats.errors).toEqual([]);
    const rows = await txs(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(foreign);
    expect((await q<{ manual_category: string }>(a.client, 'SELECT manual_category FROM transactions'))[0].manual_category).toBe('Grocery');
    expect(server.liveRows(USER, 'transactions')).toHaveLength(1);
    const again = await cycle(a);
    expect(again.errors).toEqual([]);
  });
});

describe('conflict_unique on a duplicate CSV row', () => {
  it('is reported once and resolved by pulling the server row (our copy takes its id)', async () => {
    const a = await device();
    await enable(a);
    use(a);
    const acct = await createCsvAccount('Chase Checking', 'depository', 'checking');
    await cycle(a); // account is on the server
    await importFile(a, acct, [FILE[2]], 'hash-1');
    const mine = (await txs(a))[0];
    const wire = (await q<{ wire_id: string }>(a.client, 'SELECT wire_id FROM accounts'))[0].wire_id;
    const foreign = 'csv-00000000-0000-5000-8000-000000000002';
    expect(server.inject(USER, 'foreign', {
      op_id: 'f-tx2', tbl: 'transactions', pk: { id: foreign }, kind: 'upsert',
      fields: { account_id: wire, date: '2026-01-03', name: 'GROCERY', amount: 52.1, source: 'csv', dedup_key: mine.dedup_key },
      hlc: `${String(Date.now()).padStart(15, '0')}-00000-foreign`,
    })).toBe('accepted');
    const stats = await cycle(a);
    expect(stats.errors.map((e) => e.reason)).toEqual(['conflict_unique']);
    expect((await txs(a)).map((t) => t.id)).toEqual([foreign]);
    expect((await cycle(a)).errors).toEqual([]);
    expect((await getSyncInfo(a.client)).pendingCount).toBe(0);
  });
});

describe('dedup tie-break is deterministic across devices', () => {
  it('identical rows pair by file occurrence then id, whatever the local insertion order', () => {
    const mk = (csvId: string, key: string, rowid: number) => ({
      csvId, csvDate: '2026-01-02', csvName: 'COFFEE', csvAmount: 4.5, csvSource: 'csv' as const, accountName: 'x',
      plaidId: 'P', plaidDate: '2026-01-02', plaidName: 'COFFEE', csvRowid: rowid, plaidRowid: 1,
      csvDedupKey: key,
    });
    const rowsA = [mk('csv-b', '2026-01-02|coffee|450|1', 1), mk('csv-a', '2026-01-02|coffee|450|0', 2)];
    const rowsB = [...rowsA].reverse().map((r, i) => ({ ...r, csvRowid: i + 1 }));
    const pa = pairCandidates(rowsA as never);
    const pb = pairCandidates(rowsB as never);
    expect(pa.map((c) => c.csvId)).toEqual(['csv-a']);
    expect(pb.map((c) => c.csvId)).toEqual(['csv-a']);
  });
});
