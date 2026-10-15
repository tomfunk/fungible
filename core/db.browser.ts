// Browser-backed database: the web app's `db` / `initDb`, aliased over
// core/db.ts at bundle time (every core module imports `./db.js`).
//
// SQLite runs in a dedicated Worker (db.browser.worker.ts) on the OPFS
// SAH-pool VFS (no COOP/COEP needed). This module is the main-thread proxy:
// `db` implements the Client surface the codebase uses (execute, batch,
// migrate, executeMultiple, transaction('write'), close).
//
// Must not import node:*, core/in-use or core/snapshot, crypto.ts, paths.ts.
//
// Sync: initDb creates the base schema only and leaves the install local-only
// (BYOK). The web layer calls enableHostedMode({ snapshot: false }) when the
// user connects; it also registers the adoption hook as a no-op.
//
// Single tab only: a second tab makes initDb() reject with code OPFS_LOCKED.
// No in-memory fallback unless initDb({ allowMemoryFallback: true }).
import type { Client } from '@libsql/client';
import {
  CREATE_TABLES, COLUMN_MIGRATIONS, FLEX_DEFAULTS, HIDDEN_CATEGORY_DEFAULTS,
  DEFAULT_CATEGORIES, SOURCE_COLUMN_WIDE_SQL,
} from './db-schema.js';
import { BASE_USER_VERSION } from './schema-version.js';
import {
  ProxyClient,
  errorFromWire,
  type OpenResult,
  type WorkerCall,
  type WorkerResponse,
} from './db.browser.proto.js';

export interface InitDbOptions {
  /** Permit a non-persistent in-memory DB when OPFS is unavailable or locked. Default false. */
  allowMemoryFallback?: boolean;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let persistent = false;
let opened: Promise<OpenResult> | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./db.browser.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const r = ev.data;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(errorFromWire(r.error));
  };
  w.onerror = (ev) => {
    const err = new Error(ev.message || 'database worker failed');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker = w;
  return w;
}

function request(req: WorkerCall): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...req, id });
  });
}

const proxy = new ProxyClient(request);
export const db: Client = proxy as unknown as Client;

/** True once initDb() has opened a database stored in OPFS (survives reload). */
export function isPersistent(): boolean {
  return persistent;
}

/**
 * Wipe the persisted database. Queues behind an open transaction; the worker
 * is terminated afterwards, later db calls reject with code DB_NOT_OPEN until
 * initDb() runs again.
 */
export async function resetBrowserDb(): Promise<void> {
  await proxy.reset();
  worker?.terminate();
  worker = null;
  persistent = false;
  opened = null;
}

export async function initDb(opts: InitDbOptions = {}): Promise<void> {
  opened ??= request({ op: 'open', opts: { allowMemoryFallback: !!opts.allowMemoryFallback } }) as Promise<OpenResult>;
  try {
    persistent = (await opened).persistent;
  } catch (e) {
    opened = null;
    worker?.terminate();
    worker = null;
    throw e;
  }

  await db.batch(CREATE_TABLES, 'write');

  for (const base of COLUMN_MIGRATIONS) {
    // A browser database is always created by this code, so it takes the
    // widened 'manual' source CHECK directly (no rebuild path needed).
    const sql = base.startsWith('ALTER TABLE transactions ADD COLUMN source') ? SOURCE_COLUMN_WIDE_SQL : base;
    try {
      await db.execute(sql);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
  }

  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_dedup
     ON transactions(account_id, dedup_key) WHERE dedup_key IS NOT NULL`,
  );
  await db.execute('CREATE INDEX IF NOT EXISTS idx_transactions_import ON transactions(import_id)');

  await db.batch(
    FLEX_DEFAULTS.map(([cat, flex]) => ({
      sql: 'UPDATE categories SET flexibility = ? WHERE name = ? AND flexibility IS NULL',
      args: [flex, cat],
    })),
    'write',
  );
  await db.batch(
    HIDDEN_CATEGORY_DEFAULTS.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO hidden_categories (category) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // No profile.json in the browser: same empty-self fallback db.ts uses.
  const hmCount = await db.execute('SELECT COUNT(*) as n FROM household_members');
  if (Number(hmCount.rows[0].n) === 0) {
    await db.execute({
      sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,0)',
      args: ['self', '', 0],
    });
  }

  await db.batch(
    DEFAULT_CATEGORIES.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // Stamp the base schema version exactly as db.ts does (never lowers).
  const uv = await db.execute('PRAGMA user_version');
  if (Number((uv.rows[0] as unknown as { user_version: number | bigint }).user_version) === 0) {
    await db.execute(`PRAGMA user_version = ${BASE_USER_VERSION}`);
  }
}
