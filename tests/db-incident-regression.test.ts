/**
 * Regression tests for the 2026-06 database incidents: two processes writing
 * the same fungible.db (TUI/GUI + MCP server) failing instantly with
 * SQLITE_BUSY, plus the safety nets around it (sync ordering, backups).
 *
 * Everything runs against temp dirs from tests/helpers/tempFileDb.ts; the real
 * ~/.fungible is never touched.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { makeTempDataDir, openTempDb, spawnWriter, type TempDataDir } from './helpers/tempFileDb.js';
import { makeFakePlaid } from './helpers/makeFakeProvider.js';
import { makePlaidTx, makePlaidAccount } from './helpers/makePlaidTx.js';

const count = async (db: Client, table: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

async function integrity(db: Client): Promise<string> {
  return String((await db.execute('PRAGMA integrity_check')).rows[0][0]);
}

const temps: TempDataDir[] = [];
const clients: Client[] = [];
function tmp(): TempDataDir { const t = makeTempDataDir('fungible-incident-'); temps.push(t); return t; }
async function open(t: TempDataDir): Promise<Client> { const c = await openTempDb(t.dbPath); clients.push(c); return c; }

afterEach(() => {
  while (clients.length) clients.pop()!.close();
  while (temps.length) temps.pop()!.cleanup();
});

// ─── 1a / 1b: concurrent writers ──────────────────────────────────────────────

describe('concurrent writers to one fungible.db (SQLITE_BUSY incident)', () => {
  it('three processes x 150 batches all commit: no SQLITE_BUSY, no torn batches, db intact', async () => {
    const t = tmp();
    const db = await open(t);
    const ids = ['a', 'b', 'c'];
    const rs = await Promise.all(ids.map((id) =>
      spawnWriter({ dataDir: t.dir, env: { WRITER_ID: id, WRITER_BATCHES: '150' } })));

    expect(rs.flatMap((r) => r.report?.errors ?? ['no report: ' + r.stderr])).toEqual([]);
    expect(rs.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    expect(await count(db, 'tags')).toBe(450);
    expect(await count(db, 'transactions')).toBe(450);
    expect(await count(db, 'transaction_tags')).toBe(450);
    expect(await integrity(db)).toBe('ok');
    expect(fs.existsSync(`${t.dbPath}-journal`)).toBe(false);
  }, 120_000);

  // Pin (not a bug repro): in one process libsql serialises on a single
  // connection, so this passed even before the fix.
  it('pin: two clients in one process interleaving 200 batches each lose nothing', async () => {
    const t = tmp();
    const a = await open(t);
    const b = createClient({ url: `file:${t.dbPath}` });
    clients.push(b);
    const write = (db: Client, id: string, i: number) => db.batch([
      { sql: 'INSERT INTO tags (name) VALUES (?)', args: [`${id}-${i}`] },
      { sql: `INSERT INTO transactions (id, account_id, date, name, amount, source) VALUES (?, 'acct', '2026-01-01', ?, 1, 'manual')`, args: [`${id}-${i}`, `${id}-${i}`] },
    ], 'write');
    const run = async (db: Client, id: string) => { for (let i = 0; i < 200; i++) await write(db, id, i); };
    await Promise.all([run(a, 'a'), run(b, 'b')]);
    expect(await count(a, 'tags')).toBe(400);
    expect(await count(a, 'transactions')).toBe(400);
    expect(await integrity(a)).toBe('ok');
  }, 60_000);
});

// ─── real core modules against a temp data dir ────────────────────────────────

const ORIGINAL_ENV = process.env.FUNGIBLE_DATA_DIR;
function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env.FUNGIBLE_DATA_DIR;
  else process.env.FUNGIBLE_DATA_DIR = ORIGINAL_ENV;
}
afterAll(() => {
  restoreEnv();
  vi.doUnmock('../core/plaid.js');
});

/** Fresh core module graph whose DATA_DIR is `t.dir` (paths/crypto/db read the env at load). */
async function loadCore(t: TempDataDir, { init = true } = {}) {
  process.env.FUNGIBLE_DATA_DIR = t.dir;
  vi.resetModules();
  const dbMod = await import('../core/db.js');
  if (init) await dbMod.initDb();
  clients.push(dbMod.db);
  // The temp-dir guard refuses a path equal to an inherited FUNGIBLE_DATA_DIR
  // (spawnWriter, cleanup), and the modules above have already read it.
  restoreEnv();
  return dbMod;
}

// ─── 1c: sync failure ordering ────────────────────────────────────────────────

/*
 * Sync is NOT one atomic transaction: accounts/balances, the transaction
 * upserts, tag rules, removals and the cursor are separate batches. Each batch
 * is atomic on its own, and the invariant that makes a mid-sync failure safe
 * is: the cursor advances LAST, and every upsert is idempotent, so a retry
 * replays the same pages and converges.
 */
describe('syncTransactions failure ordering', () => {
  afterEach(() => { vi.doUnmock('../core/plaid.js'); });

  async function setup() {
    const t = tmp();
    const { db } = await loadCore(t);
    let current: ReturnType<typeof makeFakePlaid>;
    vi.doMock('../core/plaid.js', () => ({
      getPlaidClient: () => current,
      plaidErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    }));
    const plaid = (opts: Parameters<typeof makeFakePlaid>[0]) =>
      (current = makeFakePlaid({ accounts: [makePlaidAccount()], ...opts }));
    const { syncTransactions } = await import('../core/sync.js');
    const cursor = async () => (await db.execute("SELECT cursor FROM sync_state WHERE account_id = 'item-1'")).rows[0]?.cursor ?? null;
    return { db, plaid, syncTransactions, cursor };
  }
  const tx = (id: string, extra: Record<string, unknown> = {}) =>
    makePlaidTx({ transaction_id: id, name: `Merchant ${id}`, ...extra } as never);

  it('a failing upsert batch writes none of its rows and does not save the cursor; retry converges', async () => {
    const { db, plaid, syncTransactions, cursor } = await setup();
    await db.execute("CREATE TRIGGER boom BEFORE INSERT ON transactions WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const pages = [{ added: [tx('good-1'), tx('bad'), tx('good-2')] }];
    plaid({ pages });

    await expect(syncTransactions('tok', 'item-1')).rejects.toThrow(/boom/);
    expect(await count(db, 'transactions')).toBe(0);   // good-1 rolled back with the batch
    expect(await cursor()).toBeNull();
    expect(await count(db, 'accounts')).toBe(1);        // earlier batch is separate and stays

    await db.execute('DROP TRIGGER boom');
    plaid({ pages });
    await syncTransactions('tok', 'item-1');
    expect(await count(db, 'transactions')).toBe(3);
    expect(await cursor()).toBe('cursor-1');
  });

  it('a failure after the upserts (tag rules) leaves the cursor unmoved; the replay is idempotent and keeps manual categories', async () => {
    const { db, plaid, syncTransactions, cursor } = await setup();
    await db.execute("INSERT INTO tags (name) VALUES ('all')");
    await db.execute("INSERT INTO tag_rules (priority, match_type, pattern, tag_id) VALUES (0, 'all', '', 1)");
    await db.execute("CREATE TRIGGER nope BEFORE INSERT ON transaction_tags BEGIN SELECT RAISE(ABORT, 'tag-fail'); END");
    const mk = () => [tx('t1', { primaryCategory: 'FOOD_AND_DRINK' }), tx('t2'), tx('t3')];
    plaid({ pages: [{ added: mk() }] });

    await expect(syncTransactions('tok', 'item-1')).rejects.toThrow(/tag-fail/);
    expect(await cursor()).toBeNull();
    expect(await count(db, 'transactions')).toBe(3);    // upserts were already committed
    expect(await count(db, 'transaction_tags')).toBe(0);

    // User categorises a row between the failed run and the retry.
    await db.execute("UPDATE transactions SET manual_category = 'Travel', category = 'Travel' WHERE id = 't1'");
    await db.execute('DROP TRIGGER nope');
    plaid({ pages: [{ added: mk() }] });
    await syncTransactions('tok', 'item-1');

    expect(await count(db, 'transactions')).toBe(3);    // exactly N, no duplicates
    expect(await count(db, 'transaction_tags')).toBe(3);
    expect(await cursor()).toBe('cursor-1');
    const t1 = (await db.execute("SELECT category, manual_category FROM transactions WHERE id = 't1'")).rows[0];
    expect([t1.category, t1.manual_category]).toEqual(['Travel', 'Travel']);
  });

  it('a failing removal batch deletes nothing (children included) and does not advance the cursor', async () => {
    const { db, plaid, syncTransactions, cursor } = await setup();
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('acct-1', 'Checking', 'depository')");
    for (const id of ['r1', 'r2']) {
      await db.execute({ sql: `INSERT INTO transactions (id, account_id, date, name, amount, source) VALUES (?, 'acct-1', '2025-01-01', 'x', 1, 'plaid')`, args: [id] });
    }
    await db.execute("INSERT INTO tags (name) VALUES ('keep')");
    await db.execute("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('r1', 1), ('r2', 1)");
    await db.execute("INSERT INTO sync_state (account_id, cursor) VALUES ('item-1', 'old')");
    await db.execute("CREATE TRIGGER nodel BEFORE DELETE ON transactions WHEN OLD.id = 'r2' BEGIN SELECT RAISE(ABORT, 'del-fail'); END");
    plaid({ pages: [{ removed: ['r1', 'r2'] }] });

    await expect(syncTransactions('tok', 'item-1')).rejects.toThrow(/del-fail/);
    expect(await count(db, 'transactions')).toBe(2);
    expect(await count(db, 'transaction_tags')).toBe(2); // r1's link was not half-deleted
    expect(await cursor()).toBe('old');

    await db.execute('DROP TRIGGER nodel');
    plaid({ pages: [{ removed: ['r1', 'r2'] }] });
    await syncTransactions('tok', 'item-1');
    expect(await count(db, 'transactions')).toBe(0);
    expect(await count(db, 'transaction_tags')).toBe(0);
    expect(await cursor()).toBe('cursor-1');
  });
});

// ─── busy_timeout is actually applied ─────────────────────────────────────────

describe('core/db busy_timeout', () => {
  const pragma = async (db: Client) => Number((await db.execute('PRAGMA busy_timeout')).rows[0][0]);

  it('a fresh import of core/db reads PRAGMA busy_timeout = 5000', async () => {
    const { db, BUSY_TIMEOUT_MS } = await loadCore(tmp(), { init: false });
    expect(BUSY_TIMEOUT_MS).toBe(5000);
    expect(await pragma(db)).toBe(5000);
  });

  // Latent trap, deferred fix. After `await db.transaction()` + rollback/commit
  // the libsql client drops its connection (#db = null) and the next statement
  // opens a NEW connection, which has the default busy_timeout of 0 again, so
  // cross-process writes are back to failing instantly with SQLITE_BUSY. No
  // current code calls db.transaction/migrate. The fix (re-apply the pragma when
  // the connection is replaced) is not in core/db.ts yet; flip to `it` then.
  it.fails('keeps busy_timeout = 5000 after a db.transaction() round trip', async () => {
    const { db } = await loadCore(tmp(), { init: false });
    const tx = await db.transaction('write');
    await tx.rollback();
    tx.close();
    expect(await pragma(db)).toBe(5000);
  });
});

// ─── 1d: backup and restore ───────────────────────────────────────────────────

describe('backup and restore', () => {
  const TABLES = ['accounts', 'transactions', 'tags', 'transaction_tags', 'plaid_items', 'balance_history'];
  const dump = async (db: Client, table: string) =>
    (await db.execute(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map((r) => ({ ...r }));

  async function seed() {
    const t = tmp();
    const core = await loadCore(t);
    const crypto = await import('../core/crypto.js');
    const backup = await import('../core/backup.js');
    const { db } = core;
    const token = 'access-production-secret-token';
    await db.batch([
      "INSERT INTO accounts (id, name, type, subtype) VALUES ('a1', 'Checking', 'depository', 'checking'), ('a2', 'Card', 'credit', 'credit card')",
      ...Array.from({ length: 25 }, (_, i) => ({
        sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, source) VALUES (?, ?, '2026-02-0${(i % 9) + 1}', ?, ?, 'Food', 'plaid')`,
        args: [`tx${i}`, i % 2 ? 'a1' : 'a2', `Merchant ${i}`, i + 0.25],
      })),
      "INSERT INTO tags (name) VALUES ('t1'), ('t2')",
      "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx0', 1), ('tx1', 2)",
      { sql: "INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item-1', ?, 'Bank')", args: [crypto.encryptToken(token)] },
      "INSERT INTO balance_history (account_id, balance, date) VALUES ('a1', 100.5, '2026-02-01'), ('a1', 120.5, '2026-02-02'), ('a2', -50, '2026-02-02')",
    ], 'write');
    const today = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(t.dir, 'backups', `fungible.${today}.bak`);
    return { t, core, crypto, backup, db, token, backupPath };
  }

  it('produces a standalone, intact copy with the same rows and a still-decryptable token', async () => {
    const { db, backup, backupPath, crypto, token } = await seed();
    await backup.backupDb();

    expect(fs.existsSync(backupPath)).toBe(true);
    const copy = createClient({ url: `file:${backupPath}` });
    clients.push(copy);
    expect(await integrity(copy)).toBe('ok');
    expect(String((await copy.execute('PRAGMA foreign_key_check')).rows.length)).toBe('0');
    for (const table of TABLES) {
      expect(await count(copy, table), table).toBe(await count(db, table));
      expect(await dump(copy, table), table).toEqual(await dump(db, table));
    }
    const stored = String((await copy.execute('SELECT access_token FROM plaid_items')).rows[0].access_token);
    expect(stored).not.toContain(token);
    expect(crypto.decryptToken(stored)).toBe(token);
  });

  it('restoring the backup over the database and re-running initDb is idempotent and loses nothing', async () => {
    const { t, db, backup, backupPath } = await seed();
    await backup.backupDb();
    const before: Record<string, unknown[]> = {};
    for (const table of TABLES) before[table] = await dump(db, table);
    db.close();

    // Restore: copy the backup over the live file, then reopen it as a fresh process would.
    fs.copyFileSync(backupPath, t.dbPath);
    const { db: restored, initDb } = await loadCore(t, { init: false });
    await initDb();
    await initDb();

    expect(await integrity(restored)).toBe('ok');
    for (const table of TABLES) expect(await dump(restored, table), table).toEqual(before[table]);
  });

  it('excludes a transaction another connection has not committed', async () => {
    const { t, db, backup, backupPath } = await seed();
    const other = createClient({ url: `file:${t.dbPath}` });
    clients.push(other);
    const open = await other.transaction('write');
    try {
      await open.execute("INSERT INTO accounts (id, name, type) VALUES ('ghost', 'Ghost', 'depository')");
      await open.execute("INSERT INTO transactions (id, account_id, date, name, amount, source) VALUES ('ghost-tx', 'ghost', '2026-03-01', 'Ghost', 9, 'manual')");
      await backup.backupDb();
    } finally {
      await open.rollback();
      open.close();
    }
    const copy = createClient({ url: `file:${backupPath}` });
    clients.push(copy);
    expect(await count(copy, 'transactions')).toBe(25);
    expect((await copy.execute("SELECT id FROM accounts WHERE id = 'ghost'")).rows).toHaveLength(0);
    expect(await count(db, 'transactions')).toBe(25);
  });

  it('taken while a separate process is mid-write, is intact and holds only whole batches', async () => {
    const t = tmp();
    await open(t); // creates the test schema, same tables the writer child uses
    const { db } = await loadCore(t, { init: false });
    const { backupDb } = await import('../core/backup.js');
    const ids = ['a', 'b'];
    const writers = Promise.all(ids.map((id) =>
      spawnWriter({ dataDir: t.dir, env: { WRITER_ID: id, WRITER_BATCHES: '400' } })));

    // Wait until the writers are demonstrably running, then back up mid-flight.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await count(db, 'transactions')) < 20) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await backupDb();
    const rs = await writers;
    expect(rs.flatMap((r) => r.report?.errors ?? ['no report'])).toEqual([]);

    const today = new Date().toISOString().slice(0, 10);
    const copy = createClient({ url: `file:${path.join(t.dir, 'backups', `fungible.${today}.bak`)}` });
    clients.push(copy);
    expect(await integrity(copy)).toBe('ok');
    const n = await count(copy, 'transactions');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(800); // really mid-flight, not after the writers finished
    // Every batch is tag+transaction+link: a consistent snapshot has equal counts per writer.
    for (const id of ids) {
      const c = async (sql: string) => Number((await copy.execute({ sql, args: [`${id}-%`] })).rows[0].n);
      const txs = await c('SELECT COUNT(*) AS n FROM transactions WHERE id LIKE ?');
      expect(await c('SELECT COUNT(*) AS n FROM tags WHERE name LIKE ?'), id).toBe(txs);
      expect(await c('SELECT COUNT(*) AS n FROM transaction_tags WHERE transaction_id LIKE ?'), id).toBe(txs);
    }
    expect(await count(db, 'transactions')).toBe(800);
  }, 120_000);
});
