// Dedicated Worker that owns the browser SQLite database. The OPFS VFS can't
// run on the main thread (sync access handles are worker-only), which is why
// the previous main-thread @libsql/client-wasm silently fell back to memory.
//
// VFS: "opfs-sahpool" (OPFS SyncAccessHandle pool) from the libsql wasm build.
// Unlike the plain "opfs" VFS it needs no SharedArrayBuffer / COOP+COEP. It
// takes exclusive sync access handles, so a second tab fails to initialize;
// that is reported as code OPFS_LOCKED.
import {
  errorToWire,
  type OpenResult,
  type RawResult,
  type Stmt,
  type WorkerRequest,
  type WorkerResponse,
} from './db.browser.proto.js';

// The libsql wasm build (a direct dependency, resolved by bare name).
import sqlite3InitModule from '@libsql/libsql-wasm-experimental';

const DB_FILE = '/fungible.db';
const VFS_NAME = 'fungible-sahpool';
const VFS_DIR = '/fungible-sahpool';

/* eslint-disable @typescript-eslint/no-explicit-any */
let sqlite3: any;
let poolUtil: any = null;
let database: any = null;
let persistent = false;

function lockedError(cause: unknown): Error & { code: string } {
  const e = new Error(
    'Fungible is already open in another tab or window. Close the other one and reload this tab.',
  ) as Error & { code: string };
  e.code = 'OPFS_LOCKED';
  (e as any).cause = cause;
  return e;
}

function isLockError(e: any): boolean {
  return /NoModificationAllowed|InvalidState|lock|Access Handle|in use/i.test(`${e?.name ?? ''} ${e?.message ?? e}`);
}

// installOpfsSAHPoolVfs has a quirk: when initialization fails (e.g. another
// tab holds the handles) it *resolves* with the Error instead of rejecting.
async function installPool(): Promise<any> {
  const r = await sqlite3.installOpfsSAHPoolVfs({ name: VFS_NAME, directory: VFS_DIR, clearOnInit: false });
  if (r instanceof Error) throw r;
  return r;
}

async function open(opts: { allowMemoryFallback?: boolean }): Promise<OpenResult> {
  if (database) return { persistent };
  sqlite3 ??= await sqlite3InitModule();
  try {
    poolUtil = await installPool();
    database = new poolUtil.OpfsSAHPoolDb(DB_FILE);
    persistent = true;
  } catch (e: any) {
    // Exclusive handle already held by another context.
    if (isLockError(e)) {
      if (!opts.allowMemoryFallback) throw lockedError(e);
    } else if (!opts.allowMemoryFallback) {
      throw e;
    }
    database = new sqlite3.oo1.DB(':memory:', 'c');
    persistent = false;
  }
  database.exec('PRAGMA foreign_keys = ON');
  return { persistent };
}

function toSql(v: unknown): unknown {
  return v;
}

function runStmt(stmt: Stmt): RawResult {
  const st = database.prepare(stmt.sql);
  try {
    const args = stmt.args ?? [];
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; i++) st.bind(i + 1, toSql(args[i]));
    } else {
      for (const k of Object.keys(args)) {
        const name = k[0] === '@' || k[0] === '$' || k[0] === ':' ? k.slice(1) : k;
        // SQLite parameter names include their prefix (:n, @n, $n); the
        // libsql client accepts them bare, so try each prefix.
        let idx: number | undefined;
        for (const p of ['', ':', '@', '$']) {
          const i = st.getParamIndex(p + name);
          if (i) { idx = i; break; }
        }
        if (!idx) throw new Error(`Missing named parameter: ${k}`);
        st.bind(idx, toSql(args[k]));
      }
    }
    if (st.columnCount > 0) {
      const columns: string[] = st.getColumnNames();
      const rows: unknown[][] = [];
      while (st.step()) {
        rows.push(
          st.get([]).map((v: unknown) =>
            typeof v === 'bigint' && v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v,
          ),
        );
      }
      return { columns, rows, rowsAffected: 0, lastInsertRowid: null };
    }
    st.step();
    return {
      columns: [],
      rows: [],
      rowsAffected: database.changes(),
      lastInsertRowid: BigInt(database.lastInsertRowid()),
    };
  } finally {
    st.finalize();
  }
}

function inTx(): boolean {
  return database.getAutocommit() === 0;
}

function batch(stmts: Stmt[], mode: string): RawResult[] {
  const begin = mode === 'read' ? 'BEGIN TRANSACTION READONLY' : mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE';
  database.exec(begin);
  try {
    const out = stmts.map(runStmt);
    database.exec('COMMIT');
    return out;
  } finally {
    if (inTx()) database.exec('ROLLBACK');
  }
}

async function reset(): Promise<null> {
  if (database) {
    database.close();
    database = null;
  }
  if (poolUtil) {
    await poolUtil.wipeFiles();
  } else {
    // Not yet opened in this worker: open the pool just to wipe it.
    sqlite3 ??= await sqlite3InitModule();
    let pu: any;
    try {
      pu = await installPool();
    } catch (e: any) {
      throw isLockError(e) ? lockedError(e) : e;
    }
    await pu.wipeFiles();
    poolUtil = pu;
  }
  persistent = false;
  return null;
}

function requireOpen(): void {
  if (!database) {
    throw Object.assign(new Error('Database is not open: call initDb() first'), { code: 'DB_NOT_OPEN' });
  }
}

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case 'open': return open(req.opts ?? {});
    case 'execute': requireOpen(); return runStmt(req.stmt);
    case 'batch': requireOpen(); return batch(req.stmts, req.mode);
    case 'executeMultiple': requireOpen(); database.exec(req.sql); return null;
    case 'reset': return reset();
    case 'close':
      if (database) { database.close(); database = null; }
      if (poolUtil) { try { poolUtil.pauseVfs(); } catch { /* ignore */ } }
      return null;
  }
}

// Requests are processed strictly in order (one connection, one queue).
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  queue = queue.then(async () => {
    let res: WorkerResponse;
    try {
      res = { id: req.id, ok: true, result: await handle(req) };
    } catch (e) {
      res = { id: req.id, ok: false, error: errorToWire(e) };
    }
    (self as any).postMessage(res);
  });
};
