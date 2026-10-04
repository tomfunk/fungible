import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { waitFor, waitForFrame, pressAndWait, press, pressKeys, stripAnsi, frame } from './waitFor.js';
import { SCREEN_NAV } from './screenNav.js';
import { makeFakePlaid, makeFakeLlm } from './makeFakeProvider.js';
import { makePlaidTx, makePlaidAccount } from './makePlaidTx.js';
import { seedPlaidItem, seedTx } from './seedDb.js';
import { makeTestDb } from './makeTestDb.js';
import { decryptToken } from '../../core/crypto.js';
import { useFixedClock } from './fakeClock.js';
import { useTempCsv } from './tempCsv.js';
import { makeTempDataDir, openTempDb, spawnWriter, assertSafeTempPath } from './tempFileDb.js';
import { anthropicToolUse, anthropicText, interleave, openaiToolCall, openaiFinish, anthropicStream } from './makeLlmStream.js';
import { symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

describe('press / pressKeys', () => {
  it('writes keys as separate, ordered stdin writes with a tick between', async () => {
    const writes: [string, number][] = [];
    const r = { stdin: { write: (d: string) => { writes.push([d, Date.now()]); } } };
    await pressKeys(r, ['a', 'b', 'c']);
    expect(writes.map((w) => w[0])).toEqual(['a', 'b', 'c']);
    expect(writes[1][1] - writes[0][1]).toBeGreaterThanOrEqual(10);
    expect(writes[2][1] - writes[1][1]).toBeGreaterThanOrEqual(10);
  });

  it('press resolves only after the tick, and pressAndWait uses it', async () => {
    const t0 = Date.now();
    const r = { lastFrame: () => 'ready', stdin: { write: () => {} } };
    await press(r, 'x');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10);
    await pressAndWait(r, 'y', 'ready');
  });
});

describe('SCREEN_NAV', () => {
  it('covers digits 0-9 once each with unique screens and headers', () => {
    expect(SCREEN_NAV.map((n) => n.digit)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(new Set(SCREEN_NAV.map((n) => n.screen)).size).toBe(10);
    expect(new Set(SCREEN_NAV.map((n) => n.header)).size).toBe(10);
  });
});

describe('tempFileDb safety guard', () => {
  const home = path.join(os.homedir(), '.fungible');
  it('refuses ~/.fungible and anything under it', () => {
    expect(() => assertSafeTempPath(home)).toThrow(/protected|temp/);
    expect(() => assertSafeTempPath(path.join(home, 'x'))).toThrow(/protected|temp/);
    expect(() => assertSafeTempPath(path.join(home, 'fungible.db'))).toThrow();
  });
  it('refuses paths outside the OS temp dir', () => {
    expect(() => assertSafeTempPath(path.join(os.homedir(), 'elsewhere'))).toThrow(/temp dir/);
  });
  it('refuses a symlink in tmp that points into ~/.fungible', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
    const link = path.join(base, 'link');
    // Works whether or not ~/.fungible exists (dangling links are resolved too).
    try {
      symlinkSync(home, link);
      expect(() => assertSafeTempPath(link)).toThrow(/protected/);
      expect(() => assertSafeTempPath(path.join(link, 'sub'))).toThrow(/protected/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  it('refuses an inherited FUNGIBLE_DATA_DIR', () => {
    const t = makeTempDataDir();
    const prev = process.env.FUNGIBLE_DATA_DIR;
    process.env.FUNGIBLE_DATA_DIR = t.dir;
    try { expect(() => assertSafeTempPath(t.dir)).toThrow(/protected/); }
    finally {
      if (prev === undefined) delete process.env.FUNGIBLE_DATA_DIR; else process.env.FUNGIBLE_DATA_DIR = prev;
      t.cleanup();
    }
  });
  it('makeTempDataDir lives under tmp and cleanup removes it', async () => {
    const t = makeTempDataDir();
    expect(existsSync(t.dir)).toBe(true);
    const db = await openTempDb(t.dbPath);
    await db.execute("INSERT INTO tags (name) VALUES ('a')");
    expect((await db.execute('SELECT COUNT(*) c FROM tags')).rows[0].c).toBe(1);
    db.close();
    t.cleanup();
    expect(existsSync(t.dir)).toBe(false);
  });
});

describe('spawnWriter + db-writer-child', () => {
  it('a single writer succeeds with consistent triples', async () => {
    const t = makeTempDataDir();
    try {
      const db = await openTempDb(t.dbPath);
      const r = await spawnWriter({ dataDir: t.dir, env: { WRITER_ID: 'a', WRITER_BATCHES: '10' } });
      expect(r.report).toEqual({ id: 'a', ok: 10, errors: [] });
      expect(r.exitCode).toBe(0);
      const c = async (q: string) => Number((await db.execute(q)).rows[0].c);
      expect(await c('SELECT COUNT(*) c FROM tags')).toBe(10);
      expect(await c('SELECT COUNT(*) c FROM transactions')).toBe(10);
      expect(await c('SELECT COUNT(*) c FROM transaction_tags')).toBe(10);
      db.close();
    } finally { t.cleanup(); }
  }, 30_000);
});

describe('makeLlmStream', () => {
  it('splits tool input across deltas and interleaves blocks in order', async () => {
    const ev = interleave(anthropicToolUse(0, 'a', 'x', { k: 'vvvv' }, 3), anthropicToolUse(1, 'b', 'y', { z: 1 }, 2));
    const seen: unknown[] = [];
    for await (const e of anthropicStream(ev)) seen.push(e);
    expect(seen).toHaveLength(ev.length);
    const frags = ev.filter((e: any) => e.index === 0 && e.delta).map((e: any) => e.delta.partial_json);
    expect(frags.length).toBe(3);
    expect(JSON.parse(frags.join(''))).toEqual({ k: 'vvvv' });
    expect(anthropicText(0, 'a', 'b')).toHaveLength(4);
  });
  it('openai tool_call: id/name on first chunk only, finish chunk separate', () => {
    const c: any[] = openaiToolCall(0, 'id1', 'fn', { q: 1 }, 2);
    expect(c[0].choices[0].delta.tool_calls[0]).toMatchObject({ id: 'id1', function: { name: 'fn' } });
    expect(c[1].choices[0].delta.tool_calls[0].id).toBeUndefined();
    expect(openaiFinish().choices[0].finish_reason).toBe('tool_calls');
  });
});
