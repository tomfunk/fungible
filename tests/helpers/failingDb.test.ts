import { describe, it, expect } from 'vitest';
import { failDb, gateDb, captureUnhandled } from './failingDb.js';
import { SCREEN_TABLES, wipeScreenTables } from './wipeTables.js';
import { makeTestDb } from './makeTestDb.js';

describe('failDb', () => {
  it('rejects execute/batch/transaction, then restore() heals', async () => {
    const db = await makeTestDb();
    const restore = failDb(db, 'boom');
    await expect(db.execute('SELECT 1')).rejects.toThrow('boom');
    await expect(db.batch(['SELECT 1'])).rejects.toThrow('boom');
    await expect(db.transaction()).rejects.toThrow('boom');
    restore();
    expect((await db.execute('SELECT 1 AS n')).rows[0].n).toBe(1);
  });
});

describe('gateDb', () => {
  it('holds execute and batch until release()', async () => {
    const db = await makeTestDb();
    const gate = gateDb(db);
    let done = 0;
    const a = db.execute('SELECT 1').then(() => { done++; });
    const b = db.batch(['SELECT 1']).then(() => { done++; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(0);
    gate.release();
    await Promise.all([a, b]);
    expect(done).toBe(2);
    gate.restore();
  });
});

describe('captureUnhandled', () => {
  it('records unhandled rejections without failing the run, and stop() removes the listener', async () => {
    const before = process.listenerCount('unhandledRejection');
    const cap = captureUnhandled();
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    void Promise.reject(new Error('nobody catches me'));
    await new Promise((r) => setTimeout(r, 20));
    expect(cap.seen).toHaveLength(1);
    expect((cap.seen[0] as Error).message).toBe('nobody catches me');
    cap.stop();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});

describe('wipeScreenTables', () => {
  it('empties every listed table', async () => {
    const db = await makeTestDb();
    await db.execute("INSERT INTO accounts (id,name,type) VALUES ('a','A','depository')");
    await db.execute("INSERT INTO tags (name) VALUES ('t')").catch(() => {});
    await wipeScreenTables(db);
    for (const t of SCREEN_TABLES) {
      expect((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n).toBe(0);
    }
  });
});
