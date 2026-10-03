import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { waitFor, waitForFrame, pressAndWait, stripAnsi, frame } from './waitFor.js';
import { makeFakePlaid, makeFakeLlm } from './makeFakeProvider.js';
import { makePlaidTx, makePlaidAccount } from './makePlaidTx.js';
import { seedPlaidItem, seedTx } from './seedDb.js';
import { makeTestDb } from './makeTestDb.js';
import { decryptToken } from '../../core/crypto.js';
import { useFixedClock } from './fakeClock.js';
import { useTempCsv } from './tempCsv.js';

describe('waitFor', () => {
  it('resolves once the assertion passes', async () => {
    let n = 0;
    await waitFor(() => { if (++n < 3) throw new Error('no'); }, 500);
    expect(n).toBe(3);
  });
  it('times out with last error and context', async () => {
    await expect(
      waitFor(() => { throw new Error('nope'); }, { timeout: 60, context: () => 'FRAME' }),
    ).rejects.toThrow(/timed out after 60ms: nope[\s\S]*FRAME/);
  });
  it('waitForFrame / pressAndWait use the flattened frame', async () => {
    let frame = 'a\n  b';
    const r = { lastFrame: () => frame, stdin: { write: () => { frame = 'done  now'; } } };
    await waitForFrame(r, 'a b');
    await pressAndWait(r, 'x', 'done now');
    await expect(waitForFrame(r, 'zzz', 50)).rejects.toThrow(/zzz[\s\S]*done now/);
  });
});

describe('waitFor under a pinned clock', () => {
  useFixedClock();
  it('fails with the assertion error instead of spinning forever', async () => {
    await expect(
      waitFor(() => { throw new Error('still wrong'); }, { timeout: 100, interval: 10 }),
    ).rejects.toThrow(/timed out after 100ms: still wrong/);
  });
});

describe('useTempCsv', () => {
  const t = useTempCsv('helper-selftest-');
  it('writes unique files', () => {
    const a = t.csv('x,y\n1,2\n');
    const b = t.csv('z');
    expect(a).not.toBe(b);
    expect(readFileSync(a, 'utf8')).toBe('x,y\n1,2\n');
    expect(t.csv('q', 'named.csv').endsWith('named.csv')).toBe(true);
  });
  it('dispose removes the dir and is idempotent', () => {
    const t2 = useTempCsv('helper-selftest2-', { autoCleanup: false });
    t2.csv('a');
    t2.dispose(); t2.dispose();
    expect(existsSync(t2.dir)).toBe(false);
  });
});

describe('stripAnsi / frame', () => {
  it('strips colour codes and keeps line structure', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m\nx')).toBe('red\nx');
    expect(frame({ lastFrame: () => '\x1b[32mok\x1b[39m\n b' })).toBe('ok\n b');
    expect(frame({ lastFrame: () => undefined })).toBe('');
  });
});

describe('makeFakePlaid / makeFakeLlm', () => {
  it('pages derive has_more and cursors; Error pages reject', async () => {
    const p = makeFakePlaid({ pages: [{ added: [{ id: 1 }] }, new Error('boom')] });
    const first = await p.transactionsSync();
    expect(first.data).toMatchObject({ has_more: true, next_cursor: 'cursor-1' });
    await expect(p.transactionsSync()).rejects.toThrow('boom');
  });
  it('llm replays scripted replies and records requests', async () => {
    const l = makeFakeLlm(['a', (r) => `echo:${String(r)}`]);
    expect(await l.complete('x')).toBe('a');
    expect(await l.complete('y')).toBe('echo:y');
    expect(l.calls()).toEqual(['x', 'y']);
  });
});

describe('makeFakePlaid extras', () => {
  it('records the request cursor, modified/removed pass through, accounts can change per sync', async () => {
    const p = makeFakePlaid({
      pages: [{ modified: [makePlaidTx({ transaction_id: 'm1', pending: false })], removed: ['r1'] }],
      accountsPerSync: [[makePlaidAccount({ current: 1 })], [makePlaidAccount({ current: 2 })]],
    });
    const res = await p.transactionsSync({ access_token: 't', cursor: 'c0' });
    expect(p.transactionsSync.mock.calls[0][0]?.cursor).toBe('c0');
    expect(res.data.modified).toHaveLength(1);
    expect(res.data.removed).toEqual([{ transaction_id: 'r1' }]);
    expect((await p.accountsGet()).data.accounts[0]).toMatchObject({ balances: { current: 1 } });
    expect((await p.accountsGet()).data.accounts[0]).toMatchObject({ balances: { current: 2 } });
    expect((await p.accountsGet()).data.accounts[0]).toMatchObject({ balances: { current: 2 } });
  });
  it('accountsError rejects accountsGet', async () => {
    const p = makeFakePlaid({ accountsError: new Error('acct down') });
    await expect(p.accountsGet()).rejects.toThrow('acct down');
  });
});

describe('makePlaidTx / makePlaidAccount', () => {
  it('gives unique ids, Plaid shape and overridable fields', () => {
    const a = makePlaidTx();
    const b = makePlaidTx({ pending: true, primaryCategory: 'FOOD_AND_DRINK', amount: 4.5 });
    expect(a.transaction_id).not.toBe(b.transaction_id);
    expect(b).toMatchObject({ pending: true, amount: 4.5, personal_finance_category: { primary: 'FOOD_AND_DRINK' } });
    expect(makePlaidTx({ primaryCategory: null }).personal_finance_category).toBeNull();
  });
  it('account balances.current can be null', () => {
    expect(makePlaidAccount({ current: null }).balances.current).toBeNull();
    expect(makePlaidAccount({ current: undefined }).balances.current).toBeUndefined();
    expect(makePlaidAccount({ current: 0 }).balances.current).toBe(0);
    expect(makePlaidAccount().balances.current).toBe(100);
  });
});

describe('seedPlaidItem / seedTx', () => {
  it('seedPlaidItem stores a token decryptToken passes through unchanged', async () => {
    const db = await makeTestDb();
    const { accessToken } = await seedPlaidItem(db, 'item-1', { lastSyncedAt: 123 });
    const row = (await db.execute("SELECT access_token, last_synced_at FROM plaid_items WHERE item_id='item-1'")).rows[0];
    expect(row.access_token).toBe(accessToken);
    expect(row.last_synced_at).toBe(123);
    expect(decryptToken(String(row.access_token))).toBe(accessToken);
  });
  it('seedTx writes defaults, honours overrides and returns the row', async () => {
    const db = await makeTestDb();
    const a = await seedTx(db);
    const b = await seedTx(db, { source: 'csv', manual_category: 'Dining', display_name: 'Latte', ignored: true, pending: true, original_date: '2024-12-30', amount: -5 });
    expect(a.id).not.toBe(b.id);
    const rows = (await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [b.id] })).rows[0];
    expect(rows).toMatchObject({ source: 'csv', manual_category: 'Dining', display_name: 'Latte', ignored: 1, pending: 1, original_date: '2024-12-30', amount: -5 });
    expect((await db.execute({ sql: 'SELECT source, pending, ignored FROM transactions WHERE id = ?', args: [a.id] })).rows[0])
      .toMatchObject({ source: 'plaid', pending: 0, ignored: 0 });
  });
});
