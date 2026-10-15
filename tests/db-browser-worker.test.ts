// Drives the real browser-DB worker module under Node (wasm SQLite, :memory:
// via allowMemoryFallback since OPFS does not exist here) through the real
// ProxyClient. Covers the message protocol, error codes, transaction usage as
// the op-log engine does it, and reset behaviour. Real OPFS persistence and
// the OPFS_LOCKED path are verified in a browser by the web e2e.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProxyClient, type WorkerCall, type WorkerResponse } from '../core/db.browser.proto.js';
import { CREATE_TABLES } from '../core/db-schema.js';

type Handler = ((ev: { data: unknown }) => void) | null;
const fakeSelf: { onmessage: Handler; postMessage: (r: WorkerResponse) => void } = {
  onmessage: null,
  postMessage: () => {},
};
const waiters = new Map<number, (r: WorkerResponse) => void>();
let nextId = 1;
fakeSelf.postMessage = (r) => waiters.get(r.id)?.(r);

function request(req: WorkerCall): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiters.set(id, (r) => {
      waiters.delete(id);
      if (r.ok) resolve(r.result);
      else reject(Object.assign(new Error(r.error.message), { code: r.error.code }));
    });
    fakeSelf.onmessage!({ data: { ...req, id } });
  });
}

let client: ProxyClient;
const prevSelf = (globalThis as { self?: unknown }).self;

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = fakeSelf;
  await import('../core/db.browser.worker.js');
  client = new ProxyClient(request);
});
afterAll(() => {
  (globalThis as { self?: unknown }).self = prevSelf;
});

describe('browser db worker (in-process)', () => {
  it('rejects calls before open with DB_NOT_OPEN', async () => {
    await expect(client.execute('SELECT 1')).rejects.toMatchObject({ code: 'DB_NOT_OPEN' });
  });

  it('opens in memory when fallback is allowed and runs the shared schema', async () => {
    const r = (await request({ op: 'open', opts: { allowMemoryFallback: true } })) as { persistent: boolean };
    expect(r.persistent).toBe(false);
    await client.batch(CREATE_TABLES, 'write');
    const tables = await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'`);
    expect(tables.rows).toHaveLength(1);
  });

  it('round-trips args, rowsAffected, bigint rowids and named args', async () => {
    const ins = await client.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['food'] });
    expect(ins.rowsAffected).toBe(1);
    expect(typeof ins.lastInsertRowid).toBe('bigint');
    const sel = await client.execute({ sql: 'SELECT id, name FROM tags WHERE name = :n', args: { n: 'food' } });
    expect(sel.rows[0].name).toBe('food');
    expect(sel.rows[0][1]).toBe('food');
    await client.execute({ sql: `INSERT INTO settings (key, value) VALUES (?, ?)`, args: ['k', true] });
    expect((await client.execute(`SELECT value FROM settings WHERE key='k'`)).rows[0].value).toBe('1');
  });

  it('surfaces SQL errors and rolls back a failed batch', async () => {
    await expect(
      client.batch(
        [{ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['dup-a'] }, { sql: 'INSERT INTO nope VALUES (1)' }],
        'write',
      ),
    ).rejects.toThrow();
    const n = await client.execute(`SELECT COUNT(*) AS n FROM tags WHERE name = 'dup-a'`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it('engine-style interactive transaction: execute+commit persists, rollback discards, outside calls wait', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['committed'] });
    const outside = client.execute(`SELECT COUNT(*) AS n FROM tags WHERE name = 'committed'`);
    await tx.commit();
    expect(Number((await outside).rows[0].n)).toBe(1);
    tx.close();

    const tx2 = await client.transaction('write');
    await tx2.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['rolled'] });
    await tx2.rollback();
    tx2.close();
    const n = await client.execute(`SELECT COUNT(*) AS n FROM tags WHERE name = 'rolled'`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it('transaction.close without commit rolls back and releases the gate', async () => {
    const tx = await client.transaction('write');
    await tx.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['abandoned'] });
    tx.close();
    const n = await client.execute(`SELECT COUNT(*) AS n FROM tags WHERE name = 'abandoned'`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it('executeMultiple runs several statements', async () => {
    await client.executeMultiple(`CREATE TABLE zz (a); INSERT INTO zz VALUES (1); INSERT INTO zz VALUES (2);`);
    expect(Number((await client.execute('SELECT COUNT(*) AS n FROM zz')).rows[0].n)).toBe(2);
  });

  it('reset closes the database; later calls reject with DB_NOT_OPEN', async () => {
    // In-memory (no pool): reset is expected to fail to open OPFS under Node,
    // so only assert the open-state contract on the surface we can reach.
    await request({ op: 'close' });
    await expect(client.execute('SELECT 1')).rejects.toMatchObject({ code: 'DB_NOT_OPEN' });
  });
});
