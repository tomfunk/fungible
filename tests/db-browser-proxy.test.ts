// Unit tests for the browser DB proxy's wire (de)serialization. The real
// transport is a Worker over OPFS (verified in a browser); here a fake
// transport answers with the raw shapes the worker produces.
import { describe, it, expect } from 'vitest';
import {
  ProxyClient,
  buildResultSet,
  serializeStmt,
  errorFromWire,
  errorToWire,
  type WorkerCall,
  type RawResult,
} from '../core/db.browser.proto.js';

function fake(handler: (req: WorkerCall) => unknown) {
  const calls: WorkerCall[] = [];
  const client = new ProxyClient(async (req) => {
    calls.push(req);
    return handler(req);
  });
  return { client, calls };
}

const raw = (over: Partial<RawResult> = {}): RawResult => ({
  columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], rowsAffected: 0, lastInsertRowid: null, ...over,
});

describe('result sets', () => {
  it('rows are accessible by index and by name; length is hidden', () => {
    const rs = buildResultSet(raw());
    expect(rs.rows[0].name).toBe('a');
    expect(rs.rows[0][0]).toBe(1);
    expect(rs.rows[1][1]).toBe('b');
    expect(Object.keys(rs.rows[0])).toEqual(['id', 'name']);
    expect(rs.columns).toEqual(['id', 'name']);
  });

  it('keeps bigint lastInsertRowid and maps null to undefined', () => {
    expect(buildResultSet(raw({ rows: [], lastInsertRowid: 7n, rowsAffected: 1 })).lastInsertRowid).toBe(7n);
    expect(buildResultSet(raw()).lastInsertRowid).toBeUndefined();
  });

  it('duplicate column names keep the first value for name access', () => {
    const rs = buildResultSet({ columns: ['x', 'x'], rows: [[1, 2]], rowsAffected: 0, lastInsertRowid: null });
    expect(rs.rows[0].x).toBe(1);
    expect(rs.rows[0][1]).toBe(2);
  });
});

describe('argument serialization', () => {
  it('converts Date and boolean, preserves blobs and bigint', () => {
    const blob = new Uint8Array([1, 2]);
    const s = serializeStmt({ sql: 'x', args: [new Date(5), true, false, 3n, blob, null] });
    expect(s.args).toEqual([5, 1, 0, 3n, blob, null]);
  });

  it('handles named args and rejects undefined', () => {
    expect(serializeStmt({ sql: 'x', args: { a: true, b: 'z' } }).args).toEqual({ a: 1, b: 'z' });
    expect(() => serializeStmt({ sql: 'x', args: [undefined as never] })).toThrow(/undefined/);
  });
});

describe('ProxyClient', () => {
  it('execute accepts (sql, args) and {sql,args}', async () => {
    const { client, calls } = fake(() => raw());
    await client.execute('SELECT ?', [1]);
    await client.execute({ sql: 'SELECT :a', args: { a: 2 } });
    expect(calls.map((c) => (c as { stmt: { args: unknown } }).stmt.args)).toEqual([[1], { a: 2 }]);
  });

  it('batch returns one ResultSet per statement and forwards mode', async () => {
    const { client, calls } = fake(() => [raw(), raw({ rows: [], rowsAffected: 3 })]);
    const out = await client.batch(['A', { sql: 'B', args: [1] }], 'write');
    expect(out).toHaveLength(2);
    expect(out[1].rowsAffected).toBe(3);
    expect(calls[0]).toMatchObject({ op: 'batch', mode: 'write' });
  });

  it('worker errors keep their code', async () => {
    const { client } = fake(() => {
      throw errorFromWire({ message: 'locked', code: 'OPFS_LOCKED' });
    });
    await expect(client.execute('x')).rejects.toMatchObject({ code: 'OPFS_LOCKED', message: 'locked' });
    expect(errorToWire(Object.assign(new Error('m'), { code: 'C' }))).toMatchObject({ message: 'm', code: 'C' });
  });

  it('a transaction blocks other calls until commit', async () => {
    const order: string[] = [];
    const { client } = fake((req) => {
      order.push(req.op === 'execute' ? (req as { stmt: { sql: string } }).stmt.sql : req.op);
      return raw({ rows: [] });
    });
    const tx = await client.transaction('write');
    const other = client.execute('OUTSIDE');
    await tx.execute('INSIDE');
    await new Promise((r) => setTimeout(r, 5));
    expect(order).not.toContain('OUTSIDE');
    await tx.commit();
    await other;
    expect(order).toEqual(['BEGIN IMMEDIATE', 'INSIDE', 'COMMIT', 'OUTSIDE']);
  });

  it('rollback after a failed begin releases the gate', async () => {
    let fail = true;
    const { client } = fake(() => {
      if (fail) { fail = false; throw new Error('busy'); }
      return raw({ rows: [] });
    });
    await expect(client.transaction()).rejects.toThrow('busy');
    await expect(client.execute('SELECT 1')).resolves.toBeDefined();
  });
});

describe('ProxyClient.reset', () => {
  it('waits for an open transaction before wiping', async () => {
    const order: string[] = [];
    const { client } = fake((req) => {
      order.push(req.op === 'execute' ? (req as { stmt: { sql: string } }).stmt.sql : req.op);
      return raw({ rows: [] });
    });
    const tx = await client.transaction('write');
    const wipe = client.reset();
    await tx.execute('INSIDE');
    await new Promise((r) => setTimeout(r, 5));
    expect(order).not.toContain('reset');
    await tx.commit();
    await wipe;
    expect(order).toEqual(['BEGIN IMMEDIATE', 'INSIDE', 'COMMIT', 'reset']);
  });
});
