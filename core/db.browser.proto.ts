// Wire protocol + result-set helpers shared by the browser DB proxy
// (db.browser.ts, main thread) and its Worker (db.browser.worker.ts).
//
// Pure TypeScript with no browser or sqlite imports so the (de)serialization
// can be unit-tested under Node. Everything crossing postMessage must be
// structured-cloneable: bigint, Uint8Array and ArrayBuffer all are, so values
// pass through untouched; only rows are reshaped (arrays on the wire, objects
// with index+name access on the main thread, matching @libsql/client).

export type SqlValue = null | string | number | bigint | boolean | Uint8Array | ArrayBuffer | Date;
export type StmtArgs = SqlValue[] | Record<string, SqlValue>;
export interface Stmt { sql: string; args?: StmtArgs }
export type StmtInput = string | Stmt;

/** Raw result of one statement as produced by the worker. */
export interface RawResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertRowid: bigint | null;
}

export type WorkerRequest =
  | { id: number; op: 'open'; opts: { allowMemoryFallback?: boolean } }
  | { id: number; op: 'execute'; stmt: Stmt }
  | { id: number; op: 'batch'; stmts: Stmt[]; mode: string }
  | { id: number; op: 'executeMultiple'; sql: string }
  | { id: number; op: 'reset' }
  | { id: number; op: 'close' };

export type WorkerCall = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string; name?: string } };

export interface OpenResult { persistent: boolean }

export function normalizeStmt(input: StmtInput, args?: StmtArgs): Stmt {
  if (typeof input === 'string') return { sql: input, args: args ?? [] };
  return { sql: input.sql, args: input.args ?? [] };
}

/** Cloneable form of a statement: Dates become epoch ms, booleans 0/1 (the libsql client's rule). */
export function serializeStmt(stmt: Stmt): Stmt {
  const conv = (v: SqlValue): SqlValue => {
    if (v instanceof Date) return v.valueOf();
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === undefined) throw new TypeError('undefined cannot be passed as argument to the database');
    return v;
  };
  const a = stmt.args ?? [];
  if (Array.isArray(a)) return { sql: stmt.sql, args: a.map(conv) };
  const out: Record<string, SqlValue> = {};
  for (const k of Object.keys(a)) out[k] = conv(a[k]);
  return { sql: stmt.sql, args: out };
}

/** Build a row with both index and (enumerable) column-name access, like libsql's Row. */
export function buildRow(values: unknown[], columns: string[]): Record<string | number, unknown> {
  const row: Record<string | number, unknown> = {};
  Object.defineProperty(row, 'length', { value: values.length });
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    Object.defineProperty(row, i, { value });
    const col = columns[i];
    if (!Object.hasOwn(row, col)) {
      Object.defineProperty(row, col, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return row;
}

export interface ResultSet {
  columns: string[];
  columnTypes: string[];
  rows: Record<string | number, unknown>[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
  toJSON(): unknown;
}

export function buildResultSet(raw: RawResult): ResultSet {
  const rows = raw.rows.map((r) => buildRow(r, raw.columns));
  return {
    columns: raw.columns,
    columnTypes: [],
    rows,
    rowsAffected: raw.rowsAffected,
    lastInsertRowid: raw.lastInsertRowid ?? undefined,
    toJSON() {
      return {
        columns: raw.columns,
        rows: raw.rows,
        rowsAffected: raw.rowsAffected,
        lastInsertRowid: raw.lastInsertRowid === null ? null : String(raw.lastInsertRowid),
      };
    },
  };
}

/** Re-raise a worker-side failure on the main thread, preserving `.code`. */
export function errorFromWire(e: { message: string; code?: string; name?: string }): Error & { code?: string } {
  const err = new Error(e.message) as Error & { code?: string };
  if (e.name) err.name = e.name;
  if (e.code) err.code = e.code;
  return err;
}

export function errorToWire(e: unknown): { message: string; code?: string; name?: string } {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown; name?: unknown };
    return {
      message: String(o.message ?? e),
      code: typeof o.code === 'string' ? o.code : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
    };
  }
  return { message: String(e) };
}

/**
 * Minimal Client-shaped proxy over a request function. The transport is
 * injected so the same class is exercised in unit tests (in-process fake) and
 * in the browser (postMessage to the Worker).
 */
export class ProxyClient {
  closed = false;
  readonly protocol = 'file';
  // Serializes access while a transaction() owns the single worker connection.
  private gate: Promise<void> = Promise.resolve();

  constructor(private request: (req: WorkerCall) => Promise<unknown>) {}

  private async run<T>(req: WorkerCall): Promise<T> {
    await this.gate;
    return this.request(req) as Promise<T>;
  }

  async execute(input: StmtInput, args?: StmtArgs): Promise<ResultSet> {
    const stmt = serializeStmt(normalizeStmt(input, args));
    return buildResultSet(await this.run<RawResult>({ op: 'execute', stmt }));
  }

  async batch(stmts: StmtInput[], mode: string = 'deferred'): Promise<ResultSet[]> {
    const wire = stmts.map((s) => serializeStmt(normalizeStmt(s)));
    const raws = await this.run<RawResult[]>({ op: 'batch', stmts: wire, mode });
    return raws.map(buildResultSet);
  }

  /**
   * Wipe the database. Queues behind any open transaction (the gate) and, via
   * the worker's FIFO queue, behind every already-sent request. Calls made
   * afterwards reject with code DB_NOT_OPEN until initDb() reopens.
   */
  async reset(): Promise<void> {
    await this.gate;
    await this.request({ op: 'reset' });
  }

  async migrate(stmts: StmtInput[]): Promise<ResultSet[]> {
    return this.batch(stmts, 'write');
  }

  async executeMultiple(sql: string): Promise<void> {
    await this.run({ op: 'executeMultiple', sql });
  }

  /**
   * Interactive transaction. Holds a gate so no other db.* call interleaves on
   * the shared connection until commit/rollback/close; calling db.execute from
   * inside the transaction body would therefore wait forever -- use the tx.
   */
  async transaction(mode: string = 'write') {
    await this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((r) => { release = r; });
    const begin = mode === 'read' ? 'BEGIN TRANSACTION READONLY' : mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE';
    try {
      await this.request({ op: 'execute', stmt: { sql: begin, args: [] } });
    } catch (e) {
      release();
      throw e;
    }
    let done = false;
    const finish = async (sql: string) => {
      if (done) return;
      done = true;
      try {
        await this.request({ op: 'execute', stmt: { sql, args: [] } });
      } finally {
        release();
      }
    };
    const direct = async (input: StmtInput) =>
      buildResultSet((await this.request({ op: 'execute', stmt: serializeStmt(normalizeStmt(input)) })) as RawResult);
    return {
      get closed() { return done; },
      execute: (s: StmtInput) => direct(s),
      batch: async (stmts: StmtInput[]) => {
        const out: ResultSet[] = [];
        for (const s of stmts) out.push(await direct(s));
        return out;
      },
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
      close: () => { void finish('ROLLBACK').catch(() => {}); },
    };
  }

  async sync(): Promise<never> {
    throw Object.assign(new Error('sync not supported in browser db'), { code: 'SYNC_NOT_SUPPORTED' });
  }

  close(): void {
    this.closed = true;
    void this.request({ op: 'close' }).catch(() => {});
  }
}
