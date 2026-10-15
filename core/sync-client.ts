import type { Client } from '@libsql/client';
import { db } from './db.js';
import { getAccessToken, sessionUserId } from './auth-client.js';
import { adoptByokData, setBeforeAdoptHook, type AdoptStats } from './sync-adopt.js';
import {
  SyncError, getSyncMode, readSyncState, writeSyncState, cursorKey,
} from './sync-mode.js';
import { SYNC_TABLES, isSyncedSetting } from './sync-spec.js';
import { deriveTagUuid, deriveRuleUuid } from './sync-ids.js';
import {
  OP_PENDING, OP_DONE, OP_HELD, OP_REJECTED, OP_MOOT, OP_SUPERSEDED,
} from './sync-oplog.js';
import {
  applyRemoteOp, loadMemberCtx, newApplyStats, setApplying, snapshotOps,
  type ApplyStats, type RemoteOp, type SnapshotTables,
} from './sync-apply.js';
import { formatHlc, isFarFuture, observeHlc, parseHlc } from './hlc.js';

export { setBeforeAdoptHook, SyncError };

// The one sync engine, shared by the TUI, desktop GUI, MCP server and web app.
// Local-first against the sync server's operation log (POST/GET /sync/ops); the wire
// contract is documented in core/SYNC_PROTOCOL.md.
//
// Portable: no node:* imports, no Buffer; talks to an injected libsql Client
// (default: the app's `db`) and the global fetch.
//
// BYOK inertness: runSyncCycle() returns immediately -- no query against the
// sync tables, no network -- unless `_sync_state.mode` is 'hosted'.
//
// A cycle: [bootstrap snapshot + adoption, first time or after a 410]
//          -> push pending ops -> pull ops since the cursor (paged).
// Pulled pages are applied and the cursor advanced in ONE local transaction,
// so a crash resumes exactly where it left off and a replay is harmless
// (ops are idempotent by op_id).
//
// Not synced: tag_rules / tag_rule_suppressions (no server table), canvases,
// and category/name rules scoped to an account (the server has no account_id).

// Fields/ops lost to a newer HLC while applying pulled pages this cycle (one
// cycle runs at a time per process).
let totalSuperseded = 0;

const PUSH_BATCH = 500;
const PULL_LIMIT = 500;

let _baseUrl: string | null = null;
let _fetch: typeof fetch | null = null;
let _interval: ReturnType<typeof setInterval> | null = null;
let _running: Promise<CycleStats> | null = null;

export function configureSync(baseUrl: string, opts: { fetch?: typeof fetch } = {}): void {
  _baseUrl = baseUrl.replace(/\/+$/, '');
  _fetch = opts.fetch ?? null;
}

function need(): string {
  if (!_baseUrl) throw new SyncError('not_configured');
  return _baseUrl;
}

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new SyncError('not_authenticated');
  const f = _fetch ?? globalThis.fetch;
  const res = await f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new SyncError('not_authenticated', 401);
  if (res.status === 402) throw new SyncError('not_paid', 402);
  return res;
}

type Row = Record<string, unknown>;
type Arg = string | number | null;

async function all(c: Pick<Client, 'execute'>, sql: string, args: Arg[] = []): Promise<Row[]> {
  return (await c.execute({ sql, args })).rows as unknown as Row[];
}
async function one(c: Pick<Client, 'execute'>, sql: string, args: Arg[] = []): Promise<Row | null> {
  return (await all(c, sql, args))[0] ?? null;
}

// ── Reconcile: ids, held ops ─────────────────────────────────────────────────

// Tags and rules get their server uuid from their natural key, derived here
// (SQL cannot SHA-1). Until then ops carry the local id. Idempotent; cheap
// when there is nothing to do.
async function reconcile(c: Client, userId: string): Promise<void> {
  for (const tbl of ['tags', 'category_rules', 'name_rules'] as const) {
    const scope = tbl === 'tags' ? '' : ' AND account_id IS NULL';
    const rows = await all(c, `SELECT * FROM ${tbl} WHERE uuid IS NULL${scope}`);
    for (const r of rows) {
      const uuid = tbl === 'tags'
        ? await deriveTagUuid(userId, String(r.name))
        : await deriveRuleUuid(userId, tbl, String(r.match_type), String(r.pattern));
      try {
        await c.execute({ sql: `UPDATE ${tbl} SET uuid = ? WHERE id = ? AND uuid IS NULL`, args: [uuid, Number(r.id)] });
      } catch { /* duplicate natural key: this copy stays local-only */ }
    }
    await c.execute({
      sql: `UPDATE _oplog SET pk = json_set(pk, '$.id', (SELECT uuid FROM ${tbl} WHERE ${tbl}.id = json_extract(_oplog.pk, '$.lid')))
            WHERE tbl = ? AND json_extract(pk, '$.id') IS NULL
              AND (SELECT uuid FROM ${tbl} WHERE ${tbl}.id = json_extract(_oplog.pk, '$.lid')) IS NOT NULL`,
      args: [tbl],
    });
  }
  await c.execute(
    `UPDATE _oplog SET pk = json_set(pk, '$.tag_id', (SELECT uuid FROM tags WHERE tags.id = json_extract(_oplog.pk, '$.tag_lid')))
      WHERE tbl = 'transaction_tags' AND json_extract(pk, '$.tag_id') IS NULL
        AND (SELECT uuid FROM tags WHERE tags.id = json_extract(_oplog.pk, '$.tag_lid')) IS NOT NULL`,
  );
  // Ops held for a local-only transaction become sendable once the server row is known.
  await c.execute(
    `UPDATE _oplog SET pushed = ${OP_PENDING} WHERE pushed = ${OP_HELD} AND (
       (tbl = 'transactions' AND json_extract(pk, '$.id') IN (SELECT id FROM _sync_server_tx)) OR
       (tbl = 'transaction_tags' AND json_extract(pk, '$.transaction_id') IN (SELECT id FROM _sync_server_tx)
          AND json_extract(pk, '$.tag_id') IS NOT NULL))`,
  );
}

// ── Push ─────────────────────────────────────────────────────────────────────

export type PushConflict = { table: string; id: unknown; reason: string; server_row: null };

export type PushStats = {
  accepted: number;
  superseded: number;
  retrying: number;
  clockSkew: boolean;
  errors: PushConflict[];
};

interface WireOp {
  op_id: string;
  tbl: string;
  pk: Record<string, unknown>;
  kind: 'upsert' | 'delete';
  fields?: Record<string, unknown>;
  hlc: string;
}

function identityOf(op: Row): string {
  const pk = JSON.parse(String(op.pk)) as Record<string, unknown>;
  const t = SYNC_TABLES[String(op.tbl)];
  if (!t) return String(op.pk);
  if (t.kind === 'uuid') return `${op.tbl}|${pk.id ?? `lid:${pk.lid}`}`;
  if (t.kind === 'link') return `${op.tbl}|${pk.transaction_id}|${pk.tag_id ?? `lid:${pk.tag_lid}`}`;
  return `${op.tbl}|${t.keyCols.map((c) => String(pk[c])).join('|')}`;
}

// Fold consecutive pending upserts of one row (no delete between them) into
// the latest, so a burst of edits is one op. Per-field values keep the newest.
async function coalesce(c: Client): Promise<void> {
  const ops = await all(c, `SELECT seq, op_id, tbl, pk, kind, fields FROM _oplog WHERE pushed = ${OP_PENDING} ORDER BY seq`);
  const last = new Map<string, { op_id: string; fields: Record<string, unknown> }>();
  for (const op of ops) {
    const key = identityOf(op);
    if (op.kind === 'delete') { last.delete(key); continue; }
    const fields = op.fields ? (JSON.parse(String(op.fields)) as Record<string, unknown>) : {};
    const prev = last.get(key);
    if (prev) {
      const merged = { ...prev.fields, ...fields };
      await c.execute({ sql: 'UPDATE _oplog SET fields = ?, origin = NULL WHERE op_id = ?', args: [JSON.stringify(merged), String(op.op_id)] });
      await c.execute({ sql: 'DELETE FROM _oplog WHERE op_id = ?', args: [prev.op_id] });
      last.set(key, { op_id: String(op.op_id), fields: merged });
    } else {
      last.set(key, { op_id: String(op.op_id), fields });
    }
  }
}

type Resolution =
  | { wire: WireOp }
  | { moot: string }
  | { held: string };

async function resolveForWire(
  c: Client, op: Row, member: { fwd: Map<string, string> },
): Promise<Resolution> {
  const tbl = String(op.tbl);
  const pk = JSON.parse(String(op.pk)) as Record<string, unknown>;
  const t = SYNC_TABLES[tbl];
  if (!t) return { moot: 'unknown_table' };
  const base = {
    op_id: String(op.op_id), tbl, kind: op.kind as 'upsert' | 'delete', hlc: String(op.hlc),
  };
  const fields = op.fields ? (JSON.parse(String(op.fields)) as Record<string, unknown>) : undefined;
  const withFields = (wirePk: Record<string, unknown>): Resolution => ({
    wire: { ...base, pk: wirePk, ...(base.kind === 'upsert' ? { fields: fields ?? {} } : {}) },
  });

  switch (tbl) {
    case 'categories': return withFields({ name: pk.name });
    case 'hidden_categories': return withFields({ category: pk.category });
    case 'settings':
      if (!isSyncedSetting(String(pk.key))) return { moot: 'denied_setting' };
      return withFields({ key: pk.key });
    case 'household_members': {
      const sid = member.fwd.get(String(pk.id));
      if (!sid) return { moot: 'unknown_member' };
      return withFields({ id: sid });
    }
    case 'tags': case 'category_rules': case 'name_rules': {
      if (pk.id == null) {
        const alive = pk.lid != null && (await one(c, `SELECT 1 AS x FROM ${tbl} WHERE id = ?`, [Number(pk.lid)]));
        return alive ? { held: 'no_derived_id' } : { moot: 'row_gone' };
      }
      if (base.kind === 'upsert' && tbl !== 'tags') {
        const row = await one(c, `SELECT account_id FROM ${tbl} WHERE uuid = ?`, [String(pk.id)]);
        if (row && row.account_id != null) return { moot: 'account_scoped' };
      }
      return withFields({ id: pk.id });
    }
    case 'transaction_tags': {
      if (pk.tag_id == null) {
        const alive = pk.tag_lid != null && (await one(c, 'SELECT 1 AS x FROM tags WHERE id = ?', [Number(pk.tag_lid)]));
        return alive ? { held: 'no_derived_id' } : { moot: 'tag_gone' };
      }
      if (!(await one(c, 'SELECT 1 AS x FROM _sync_server_tx WHERE id = ?', [String(pk.transaction_id)]))) {
        return { held: 'local_only_transaction' };
      }
      return withFields({ transaction_id: pk.transaction_id, tag_id: pk.tag_id });
    }
    case 'transactions': {
      if (!(await one(c, 'SELECT 1 AS x FROM _sync_server_tx WHERE id = ?', [String(pk.id)]))) {
        return { held: 'local_only_transaction' };
      }
      return withFields({ id: pk.id });
    }
    default: return { moot: 'unknown_table' };
  }
}

const GROUP_RANK: Record<string, number> = {
  categories: 0, hidden_categories: 0, settings: 0, household_members: 0,
  tags: 1, category_rules: 1, name_rules: 1, transactions: 2, transaction_tags: 3,
};

async function restamp(c: Client, opIds: string[], deviceId: string): Promise<void> {
  // Never let a skewed local clock produce a far-future HLC: anchor on the
  // newest wall time the server has shown us, if we have one.
  const remote = Number((await readSyncState('hlc_remote_wall', c)) ?? 0);
  const wall = remote > 0 ? remote : Date.now();
  let counter = 90_000; // high counter keeps these after the server's own ops of that ms
  for (const id of opIds) {
    await c.execute({ sql: 'UPDATE _oplog SET hlc = ? WHERE op_id = ?', args: [formatHlc(wall, counter++, deviceId), id] });
  }
}

async function push(c: Client, userId: string, deviceId: string): Promise<PushStats> {
  const stats: PushStats = { accepted: 0, superseded: 0, retrying: 0, clockSkew: false, errors: [] };
  await coalesce(c);
  const pending = await all(c, `SELECT * FROM _oplog WHERE pushed = ${OP_PENDING} ORDER BY seq`);
  if (pending.length === 0) return stats;
  const member = await loadMemberCtx(c, userId);

  const sendable: { wire: WireOp; row: Row }[] = [];
  for (const row of pending) {
    // Our own clock guard: a far-future HLC would be refused wholesale.
    const res = await resolveForWire(c, row, member);
    if ('moot' in res) {
      await c.execute({ sql: `UPDATE _oplog SET pushed = ${OP_MOOT}, reason = ? WHERE op_id = ?`, args: [res.moot, String(row.op_id)] });
    } else if ('held' in res) {
      await c.execute({ sql: `UPDATE _oplog SET pushed = ${OP_HELD}, reason = ? WHERE op_id = ?`, args: [res.held, String(row.op_id)] });
    } else {
      sendable.push({ wire: res.wire, row });
    }
  }
  if (sendable.length === 0) return stats;
  sendable.sort((a, b) => (GROUP_RANK[a.wire.tbl] ?? 9) - (GROUP_RANK[b.wire.tbl] ?? 9)
    || Number(a.row.seq) - Number(b.row.seq));

  const baseUrl = need();
  const nowMs = Date.now();
  for (let i = 0; i < sendable.length; i += PUSH_BATCH) {
    const batch = sendable.slice(i, i + PUSH_BATCH);
    // Pre-flight: restamp ops whose HLC the server is certain to refuse.
    const far = batch.filter((b) => isFarFuture(b.wire.hlc, nowMs));
    if (far.length > 0) {
      stats.clockSkew = true;
      await restamp(c, far.map((b) => b.wire.op_id), deviceId);
      for (const f of far) f.wire.hlc = String((await one(c, 'SELECT hlc FROM _oplog WHERE op_id = ?', [f.wire.op_id]))!.hlc);
    }
    const res = await authedFetch(`${baseUrl}/sync/ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, ops: batch.map((b) => b.wire) }),
    });
    if (!res.ok) throw new SyncError('push_failed', res.status);
    const body = (await res.json()) as {
      accepted?: string[]; rejected?: { op_id: string; reason: string }[];
    };
    const byId = new Map(batch.map((b) => [b.wire.op_id, b]));

    for (const id of body.accepted ?? []) {
      if (!byId.has(id)) continue;
      await c.execute({ sql: `UPDATE _oplog SET pushed = ${OP_DONE} WHERE op_id = ?`, args: [id] });
      stats.accepted++;
    }
    const skewed: string[] = [];
    for (const rej of body.rejected ?? []) {
      const b = byId.get(rej.op_id);
      if (!b) continue;
      const err: PushConflict = { table: b.wire.tbl, id: b.wire.pk.id ?? b.wire.pk, reason: rej.reason, server_row: null };
      switch (rej.reason) {
        case 'stale':
          // Informational: a newer write already holds this field. The server
          // keeps the op as superseded; so do we.
          await c.execute({ sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'stale' WHERE op_id = ?`, args: [rej.op_id] });
          stats.superseded++;
          break;
        case 'row_missing': case 'server_error':
          // Retryable: the op stays queued.
          stats.retrying++;
          break;
        case 'invalid_hlc':
          stats.clockSkew = true;
          skewed.push(rej.op_id);
          break;
        default: // forbidden_table, forbidden_field, invalid_pk, conflict_unique, ...
          await c.execute({ sql: `UPDATE _oplog SET pushed = ${OP_REJECTED}, reason = ? WHERE op_id = ?`, args: [rej.reason, rej.op_id] });
          stats.errors.push(err);
      }
    }
    if (skewed.length > 0) await restamp(c, skewed, deviceId);
  }
  return stats;
}

// ── Pull ─────────────────────────────────────────────────────────────────────

export type PullStats = { applied: number; skipped: number; newCursor: string | null; byok?: AdoptStats; resynced?: boolean };

type OpsPage = { ops: RemoteOp[]; next_seq: string | number | null; has_more: boolean };

function asRows(ops: RemoteOp[], tbl: string): Row[] {
  return ops.filter((o) => o.kind === 'server_upsert' && o.tbl === tbl)
    .map((o) => ({ id: o.pk.id, ...(o.pk as Row), ...((o.fields ?? {}) as Row) }));
}

async function derive(stats: ApplyStats): Promise<void> {
  // transactions.category and display_name are derived locally from rules.
  // Dynamic import: categorize/rename import db.js eagerly.
  if (stats.touchedTransactions || stats.touchedCategoryRules) {
    const { applyCategoriesToAll } = await import('./categorize.js');
    await applyCategoriesToAll();
  }
  if (stats.touchedTransactions || stats.touchedNameRules) {
    const { rebuildDisplayNames } = await import('./rename.js');
    await rebuildDisplayNames();
  }
}

interface AppliedPage { stats: ApplyStats; byok: AdoptStats }

/**
 * Apply ops and advance the cursor in one local write transaction. BYOK-era
 * data is adopted onto server rows first (it re-keys ids and must not run
 * inside the transaction's write lock).
 */
async function applyPage(
  c: Client, userId: string, ops: RemoteOp[],
  after: { cursor: string | null; bootstrapped?: boolean },
): Promise<AppliedPage> {
  const accounts = asRows(ops, 'accounts');
  const txs = asRows(ops, 'transactions');
  const byok: AdoptStats = (await getSyncMode(c)) === 'hosted' && (accounts.length > 0 || txs.length > 0)
    ? await adoptByokData(c, { accounts, transactions: txs })
    : { accounts: 0, transactions: 0, merged: 0 };

  const stats = newApplyStats();
  const tx = await c.transaction('write');
  try {
    await setApplying(tx, true);
    const ctx = await loadMemberCtx(tx, userId);
    let hlcState: { wall: number; counter: number } | null = null;
    const clock = await one(tx, 'SELECT wall, counter FROM _hlc WHERE id = 1');
    if (clock) hlcState = { wall: Number(clock.wall), counter: Number(clock.counter) };
    let remoteWall = Number((await one(tx, `SELECT value FROM _sync_state WHERE key = 'hlc_remote_wall'`))?.value ?? 0);
    const now = Date.now();
    for (const op of ops) {
      await applyRemoteOp(tx, ctx, op, stats);
      if (op.hlc) {
        if (hlcState) hlcState = observeHlc(hlcState, op.hlc, now);
        const p = parseHlc(op.hlc);
        if (p) remoteWall = Math.max(remoteWall, p.wall);
      }
    }
    if (hlcState) {
      await tx.execute({
        sql: `UPDATE _hlc SET counter = CASE WHEN ? > wall THEN ? WHEN ? = wall AND ? > counter THEN ? ELSE counter END,
                wall = MAX(wall, ?) WHERE id = 1`,
        args: [hlcState.wall, hlcState.counter, hlcState.wall, hlcState.counter, hlcState.counter, hlcState.wall],
      });
    }
    if (remoteWall > 0) {
      await tx.execute({
        sql: `INSERT INTO _sync_state (key, value) VALUES ('hlc_remote_wall', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(remoteWall)],
      });
    }
    if (after.cursor != null) {
      await tx.execute({
        sql: `INSERT INTO _sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [cursorKey(userId), after.cursor],
      });
    }
    if (after.bootstrapped) {
      await tx.execute({
        sql: `INSERT INTO _sync_state (key, value) VALUES ('bootstrapped', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [userId],
      });
    }
    await setApplying(tx, false);
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch { /* already closed */ }
    throw e;
  } finally {
    tx.close();
  }
  await derive(stats);
  // Hosted engine equivalent of the BYOK sync's post-pull pass: a CSV row that
  // is the same real transaction as a server-owned Plaid row folds into it
  // (edits transfer to the server row and ride out as ordinary annotation ops).
  // Runs after account re-keying so CSV rows already sit on server accounts.
  // Only when this page brought transactions or adopted accounts; idempotent.
  if (stats.touchedTransactions || byok.accounts + byok.transactions + byok.merged > 0) {
    const { deduplicateCsvVsPlaid } = await import('./dedup.js');
    await deduplicateCsvVsPlaid();
  }
  return { stats, byok };
}

// Snapshot bootstrap: GET /sync/pull, apply as the lowest-priority base state,
// then hand over to /sync/ops at the snapshot's server_seq. Unpushed local ops
// are kept (backfilled copies of rows the server already has lose to the
// server's value; real local edits win and push next).
async function bootstrap(c: Client, userId: string): Promise<AppliedPage> {
  const baseUrl = need();
  const res = await authedFetch(`${baseUrl}/sync/pull`);
  if (!res.ok) throw new SyncError('pull_failed', res.status);
  const body = (await res.json()) as { server_seq?: string | number | null; tables?: SnapshotTables };
  if (body.server_seq == null) throw new SyncError('bootstrap_no_server_seq');
  const ops = snapshotOps(body.tables ?? {});
  return applyPage(c, userId, ops, { cursor: String(body.server_seq), bootstrapped: true });
}

async function pullOps(c: Client, userId: string): Promise<PullStats> {
  const baseUrl = need();
  const total: PullStats = { applied: 0, skipped: 0, newCursor: null };
  let resynced = false;
  for (;;) {
    const cursor = await readSyncState(cursorKey(userId), c);
    if (cursor == null) throw new SyncError('no_cursor');
    const url = new URL(`${baseUrl}/sync/ops`);
    url.searchParams.set('since', cursor);
    url.searchParams.set('limit', String(PULL_LIMIT));
    const res = await authedFetch(url.toString());
    if (res.status === 410) {
      // The server compacted past our cursor: take a fresh snapshot, keep
      // local unpushed ops, and continue from the snapshot's seq.
      if (resynced) throw new SyncError('resync_failed', 410);
      resynced = true;
      total.resynced = true;
      const b = await bootstrap(c, userId);
      total.applied += b.stats.applied; total.skipped += b.stats.skipped;
      continue;
    }
    if (!res.ok) throw new SyncError('pull_failed', res.status);
    const page = (await res.json()) as OpsPage;
    const next = page.next_seq != null ? String(page.next_seq) : cursor;
    const out = await applyPage(c, userId, page.ops, { cursor: next });
    total.applied += out.stats.applied;
    total.skipped += out.stats.skipped;
    total.byok = out.byok.accounts + out.byok.transactions + out.byok.merged > 0
      ? { accounts: (total.byok?.accounts ?? 0) + out.byok.accounts,
          transactions: (total.byok?.transactions ?? 0) + out.byok.transactions,
          merged: (total.byok?.merged ?? 0) + out.byok.merged }
      : total.byok;
    totalSuperseded += out.stats.superseded;
    total.newCursor = next;
    if (!page.has_more || page.ops.length === 0 && next === cursor) break;
  }
  return total;
}

// ── Cycle ────────────────────────────────────────────────────────────────────

export type CycleStats = {
  /** Set when the cycle did nothing because the install is in BYOK mode. */
  inert?:           'byok';
  pushed:           number;
  adopted:          number;
  pullApplied:      number;
  pullSkipped:      number;
  /** Local BYOK-era accounts/transactions re-keyed onto server rows this cycle. */
  byokAdopted?:     { accounts: number; transactions: number };
  /** Local fields/ops that lost to a newer HLC (last-writer-wins by field). */
  superseded:       number;
  /** @deprecated alias of `superseded`. */
  conflictsRebased: number;
  /** Ops the server permanently refused (reported once; they stay local). */
  errors:           PushConflict[];
  /** @deprecated alias of `errors`. */
  conflicts:        PushConflict[];
  /** Ops the server could not place yet (row_missing) and will be retried. */
  retrying?:        number;
  /** The server refused an HLC as too far in the future: the device clock is off. */
  clockSkew?:       boolean;
  /** The server compacted past our cursor and a snapshot was re-fetched. */
  resynced?:        boolean;
};

const INERT: CycleStats = {
  inert: 'byok', pushed: 0, adopted: 0, pullApplied: 0, pullSkipped: 0,
  superseded: 0, conflictsRebased: 0, errors: [], conflicts: [],
};

async function cycle(client: Client): Promise<CycleStats> {
  if ((await getSyncMode(client)) !== 'hosted') return { ...INERT };

  // A session for a different account than the one this database syncs as must
  // never push this data into it (or pull that account's data over it).
  const storedUser = await readSyncState('user_id', client);
  const sessionUser = await sessionUserId();
  if (sessionUser == null) throw new SyncError('not_authenticated');
  if (storedUser != null && storedUser !== sessionUser) throw new SyncError('account_mismatch');
  if (storedUser == null) await writeSyncState('user_id', sessionUser, client);

  const deviceRow = await one(client, 'SELECT device_id FROM _hlc WHERE id = 1');
  const deviceId = String(deviceRow?.device_id ?? '');
  if (!deviceId) throw new SyncError('sync_not_installed');

  totalSuperseded = 0;
  await reconcile(client, sessionUser);

  let boot: AppliedPage | null = null;
  if ((await readSyncState('bootstrapped', client)) !== sessionUser
      || (await readSyncState(cursorKey(sessionUser), client)) == null) {
    boot = await bootstrap(client, sessionUser);
    totalSuperseded += boot.stats.superseded;
    await reconcile(client, sessionUser); // snapshot may have brought rows needing ids patched
  }

  const up = await push(client, sessionUser, deviceId);
  const pull = await pullOps(client, sessionUser);
  await writeSyncState('last_sync_at', new Date().toISOString(), client);

  const superseded = up.superseded + totalSuperseded;
  const byok = boot?.byok;
  const adoptedAccounts = (pull.byok?.accounts ?? 0) + (byok?.accounts ?? 0);
  const adoptedTx = (pull.byok?.transactions ?? 0) + (byok?.transactions ?? 0);
  return {
    pushed:           up.accepted,
    adopted:          0,
    pullApplied:      pull.applied + (boot?.stats.applied ?? 0),
    pullSkipped:      pull.skipped + (boot?.stats.skipped ?? 0),
    byokAdopted:      adoptedAccounts + adoptedTx > 0 ? { accounts: adoptedAccounts, transactions: adoptedTx } : undefined,
    superseded,
    conflictsRebased: superseded,
    errors:           up.errors,
    conflicts:        up.errors,
    retrying:         up.retrying,
    clockSkew:        up.clockSkew || undefined,
    resynced:         pull.resynced || undefined,
  };
}

// One cycle at a time per process: a manual sync during a background one joins it.
export function runSyncCycle(opts: { client?: Client } = {}): Promise<CycleStats> {
  if (_running) return _running;
  _running = cycle(opts.client ?? db).finally(() => { _running = null; });
  return _running;
}

// ── Status (for UI) ──────────────────────────────────────────────────────────

export type SyncInfo = {
  mode:       'byok' | 'hosted';
  configured: boolean;
  /** Ops waiting to push (excludes held and rejected). */
  pendingCount: number;
  /** @deprecated alias of `pendingCount`. */
  dirtyCount: number;
  /** Ops the server permanently refused; they stay local. */
  rejectedCount: number;
  /** Ops held back because their target exists only on this device. */
  heldCount: number;
  cursor:     string | null;
  lastSyncAt: string | null;
  userId:     string | null;
};

export async function getSyncInfo(client: Client = db): Promise<SyncInfo> {
  const mode = await getSyncMode(client);
  const userId = await readSyncState('user_id', client);
  let pendingCount = 0;
  let rejectedCount = 0;
  let heldCount = 0;
  if (mode === 'hosted' || userId != null) {
    const n = async (where: string) =>
      Number((await one(client, `SELECT COUNT(*) AS n FROM _oplog WHERE ${where}`))?.n ?? 0);
    try {
      // Annotations/links on rows only this device has are not "pending": they cannot be sent.
      pendingCount = await n(
        `pushed = ${OP_PENDING}
         AND NOT (tbl = 'transactions' AND json_extract(pk, '$.id') NOT IN (SELECT id FROM _sync_server_tx))
         AND NOT (tbl = 'transaction_tags' AND json_extract(pk, '$.transaction_id') NOT IN (SELECT id FROM _sync_server_tx))`);
      rejectedCount = await n(`pushed = ${OP_REJECTED}`);
      heldCount = await n(`pushed = ${OP_HELD}`);
    } catch { /* oplog not installed */ }
  }
  return {
    mode,
    configured: _baseUrl != null,
    pendingCount,
    dirtyCount: pendingCount,
    rejectedCount,
    heldCount,
    cursor:     userId ? await readSyncState(cursorKey(userId), client) : null,
    lastSyncAt: await readSyncState('last_sync_at', client),
    userId,
  };
}

/** @deprecated runSyncCycle records last_sync_at itself. Kept for callers that still pair them. */
export async function recordSyncTime(client: Client = db): Promise<void> {
  if ((await getSyncMode(client)) !== 'hosted') return;
  await writeSyncState('last_sync_at', new Date().toISOString(), client);
}

// Background sync is safe to start in any mode: cycles are no-ops in BYOK.
export function startBackgroundSync(intervalMs = 60_000): void {
  if (_interval) return;
  _interval = setInterval(() => {
    runSyncCycle().catch((err) => console.error('[sync] cycle error:', err));
  }, intervalMs);
}

export function stopBackgroundSync(): void {
  if (_interval) clearInterval(_interval);
  _interval = null;
}
