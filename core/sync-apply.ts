import type { Client } from '@libsql/client';
import { deriveMemberUuid } from './sync-ids.js';
import { SYNC_TABLES, SERVER_OWNED_TABLES, isSyncedSetting, type SyncTable } from './sync-spec.js';
import { OP_PENDING, OP_DONE, OP_HELD, OP_SUPERSEDED } from './sync-oplog.js';

// Applying remote operations to the local tables. Portable (no node:* imports).
//
// Everything here runs against a single libsql write transaction handed in by
// the caller (the engine also advances the cursor in it), with the
// `applying` flag set so the oplog triggers stay quiet.
//
// Conflict rule, per FIELD: a remote field value is applied only when its HLC
// is newer than the newest HLC we hold for that field of that row (our own
// pending or acknowledged ops, and remote ops already applied). Deletes are
// row-level: a delete applies only if it is newer than every op we hold for
// the row; an upsert newer than a delete revives the row. Ops we lose are
// still logged (so later comparisons see them) and counted as `superseded`.

export type Exec = Pick<Client, 'execute'>;
type Row = Record<string, unknown>;
type Arg = string | number | null;

export interface RemoteOp {
  server_seq?: string | number | null;
  op_id: string;
  device_id?: string;
  tbl: string;
  pk: Record<string, unknown>;
  kind: 'upsert' | 'delete' | 'server_upsert';
  fields?: Record<string, unknown> | null;
  hlc: string;
}

export interface ApplyStats {
  applied: number;
  skipped: number;
  /** Fields / ops (local or remote) that lost to a newer HLC. */
  superseded: number;
  /** Pulled server rows that changed derived data (category rules, names). */
  touchedTransactions: boolean;
  touchedCategoryRules: boolean;
  touchedNameRules: boolean;
}

export const newApplyStats = (): ApplyStats => ({
  applied: 0, skipped: 0, superseded: 0,
  touchedTransactions: false, touchedCategoryRules: false, touchedNameRules: false,
});

const FOREIGN_SLOT_START = 16; // child-N slots 0..15 are reserved for derived ids

function arg(v: unknown): Arg {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}
const dateOnly = (v: unknown): string => String(v).slice(0, 10);

async function all(x: Exec, sql: string, args: Arg[] = []): Promise<Row[]> {
  return (await x.execute({ sql, args })).rows as unknown as Row[];
}
async function one(x: Exec, sql: string, args: Arg[] = []): Promise<Row | null> {
  return (await all(x, sql, args))[0] ?? null;
}

export async function setApplying(x: Exec, on: boolean): Promise<void> {
  if (on) {
    await x.execute(`INSERT INTO _sync_state (key, value) VALUES ('applying', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`);
  } else {
    await x.execute(`DELETE FROM _sync_state WHERE key = 'applying'`);
  }
}

// ── Household member id mapping ──────────────────────────────────────────────

export interface MemberCtx { fwd: Map<string, string>; rev: Map<string, string> }

export async function loadMemberCtx(x: Exec, userId: string): Promise<MemberCtx> {
  const locals = new Set<string>(['self', 'spouse']);
  for (let i = 0; i < FOREIGN_SLOT_START; i++) locals.add(`child-${i}`);
  try {
    for (const r of await all(x, 'SELECT id FROM household_members')) locals.add(String(r.id));
  } catch { /* table absent */ }
  const fwd = new Map<string, string>();
  const rev = new Map<string, string>();
  for (const local of locals) {
    const sid = await deriveMemberUuid(userId, local);
    fwd.set(local, sid);
    rev.set(sid, local);
  }
  // Server ids this user did not derive (a foreign client's), pinned to the
  // slot they were first assigned.
  for (const r of await all(x, `SELECT key, value FROM _sync_state WHERE key LIKE 'member_map:%'`)) {
    const sid = String(r.key).slice('member_map:'.length);
    rev.set(sid, String(r.value));
    fwd.set(String(r.value), sid);
  }
  return { fwd, rev };
}

async function memberLocalId(x: Exec, ctx: MemberCtx, serverId: string): Promise<string> {
  const hit = ctx.rev.get(serverId);
  if (hit) return hit;
  const used = new Set<string>();
  for (const r of await all(x, 'SELECT id FROM household_members')) used.add(String(r.id));
  for (const r of await all(x, `SELECT value FROM _sync_state WHERE key LIKE 'member_map:%'`)) used.add(String(r.value));
  let n = FOREIGN_SLOT_START;
  while (used.has(`child-${n}`)) n++;
  const local = `child-${n}`;
  await x.execute({
    sql: `INSERT INTO _sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [`member_map:${serverId}`, local],
  });
  ctx.rev.set(serverId, local);
  ctx.fwd.set(local, serverId);
  return local;
}

// ── Identity / HLC lookups ───────────────────────────────────────────────────

interface Ident { where: string; args: Arg[] }

/** Identity of a row inside `_oplog.pk` (remote ops are stored in local form). */
function oplogIdent(t: SyncTable, pk: Record<string, unknown>): Ident {
  const cols = t.kind === 'uuid' || t.kind === 'annotation' ? ['id']
    : t.kind === 'link' ? ['transaction_id', 'tag_id'] : t.keyCols;
  return {
    where: cols.map((c) => `json_extract(o.pk, '$.${c}') = ?`).join(' AND '),
    args: cols.map((c) => arg(pk[c])),
  };
}

const LIVE = `o.pushed IN (${OP_PENDING}, ${OP_DONE}, ${OP_HELD})`;

async function fieldFloor(x: Exec, t: SyncTable, pk: Record<string, unknown>, field: string): Promise<string | null> {
  const id = oplogIdent(t, pk);
  const r = await one(x,
    `SELECT MAX(o.hlc) AS h FROM _oplog o, json_each(o.fields) j
      WHERE o.tbl = ? AND o.kind = 'upsert' AND ${LIVE} AND j.key = ? AND ${id.where}`,
    [t.tbl, field, ...id.args]);
  return r?.h == null ? null : String(r.h);
}

async function deleteFloor(x: Exec, t: SyncTable, pk: Record<string, unknown>): Promise<string | null> {
  const id = oplogIdent(t, pk);
  const r = await one(x,
    `SELECT MAX(o.hlc) AS h FROM _oplog o WHERE o.tbl = ? AND o.kind = 'delete' AND ${LIVE} AND ${id.where}`,
    [t.tbl, ...id.args]);
  return r?.h == null ? null : String(r.h);
}

async function anyFloor(x: Exec, t: SyncTable, pk: Record<string, unknown>): Promise<string | null> {
  const id = oplogIdent(t, pk);
  const r = await one(x, `SELECT MAX(o.hlc) AS h FROM _oplog o WHERE o.tbl = ? AND ${LIVE} AND ${id.where}`, [t.tbl, ...id.args]);
  return r?.h == null ? null : String(r.h);
}

/** Local pending ops on the row that lose to a remote write at `hlc` on `fields`. */
async function supersedeLocal(
  x: Exec, t: SyncTable, pk: Record<string, unknown>, fields: string[], hlc: string, stats: ApplyStats,
): Promise<void> {
  const id = oplogIdent(t, pk);
  const pending = await all(x,
    `SELECT o.op_id, o.fields, o.hlc, o.kind FROM _oplog o
      WHERE o.tbl = ? AND o.pushed IN (${OP_PENDING}, ${OP_HELD}) AND o.hlc < ? AND ${id.where}`,
    [t.tbl, hlc, ...id.args]);
  for (const p of pending) {
    if (p.kind === 'delete') continue; // deletes are decided by the caller
    const f = p.fields ? (JSON.parse(String(p.fields)) as Record<string, unknown>) : {};
    const lost = fields.filter((k) => k in f);
    if (lost.length === 0) continue;
    for (const k of lost) delete f[k];
    stats.superseded += lost.length;
    if (Object.keys(f).length === 0) {
      await x.execute({ sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'superseded' WHERE op_id = ?`, args: [String(p.op_id)] });
    } else {
      await x.execute({ sql: 'UPDATE _oplog SET fields = ? WHERE op_id = ?', args: [JSON.stringify(f), String(p.op_id)] });
    }
  }
}

async function logRemote(x: Exec, op: RemoteOp, localPk: Record<string, unknown>): Promise<void> {
  await x.execute({
    sql: `INSERT OR IGNORE INTO _oplog (op_id, tbl, pk, kind, fields, hlc, device_id, pushed, server_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ${OP_DONE}, ?)`,
    args: [
      op.op_id, op.tbl, JSON.stringify(localPk), op.kind === 'delete' ? 'delete' : 'upsert',
      op.fields == null ? null : JSON.stringify(op.fields), op.hlc, op.device_id ?? '',
      op.server_seq == null ? null : String(op.server_seq),
    ],
  });
}

// ── Co-owned table application ───────────────────────────────────────────────

interface Resolved {
  /** Local-form pk (for _oplog and LWW lookups). */
  pk: Record<string, unknown>;
  /** Local row selector. */
  where: string;
  args: Arg[];
}

async function resolve(x: Exec, t: SyncTable, op: RemoteOp, ctx: MemberCtx): Promise<Resolved | null> {
  const p = op.pk;
  switch (t.tbl) {
    case 'categories': return { pk: { name: String(p.name) }, where: 'name = ?', args: [String(p.name)] };
    case 'hidden_categories': return { pk: { category: String(p.category) }, where: 'category = ?', args: [String(p.category)] };
    case 'settings': {
      const key = String(p.key);
      if (!isSyncedSetting(key)) return null; // per-install key: ignore server copy
      return { pk: { key }, where: 'key = ?', args: [key] };
    }
    case 'household_members': {
      const local = await memberLocalId(x, ctx, String(p.id));
      return { pk: { id: local }, where: 'id = ?', args: [local] };
    }
    case 'transactions': return { pk: { id: String(p.id) }, where: 'id = ?', args: [String(p.id)] };
    case 'transaction_tags': {
      const tag = await one(x, 'SELECT id FROM tags WHERE uuid = ?', [String(p.tag_id)]);
      return {
        pk: { transaction_id: String(p.transaction_id), tag_id: String(p.tag_id), tag_lid: tag ? Number(tag.id) : null },
        where: 'transaction_id = ? AND tag_id = ?',
        args: [String(p.transaction_id), tag ? Number(tag.id) : -1],
      };
    }
    case 'tags': case 'category_rules': case 'name_rules': {
      const uuid = String(p.id);
      const row = await one(x, `SELECT id FROM ${t.tbl} WHERE uuid = ?`, [uuid]);
      return {
        pk: { lid: row ? Number(row.id) : null, id: uuid },
        where: 'uuid = ?', args: [uuid],
      };
    }
    default: return null;
  }
}

/**
 * A pulled tag / rule whose natural key matches a local row with another (or no)
 * uuid takes the server's uuid, so two devices that created "the same" row
 * converge on one. Account-scoped rules are never adopted.
 */
async function adoptByNaturalKey(x: Exec, t: SyncTable, uuid: string, fields: Record<string, unknown>): Promise<number | null> {
  if (!t.naturalCols) return null;
  const cols = t.naturalCols;
  if (!cols.every((c) => c in fields)) return null;
  const scope = t.scopedBy ? ` AND ${t.scopedBy} IS NULL` : '';
  const hit = await one(x, `SELECT id, uuid FROM ${t.tbl} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}${scope}`,
    cols.map((c) => arg(fields[c])));
  if (!hit) return null;
  if (hit.uuid != null && String(hit.uuid) === uuid) return Number(hit.id);
  await x.execute({ sql: `UPDATE ${t.tbl} SET uuid = ? WHERE id = ?`, args: [uuid, Number(hit.id)] });
  await x.execute({
    sql: `UPDATE _oplog SET pk = json_set(pk, '$.id', ?) WHERE tbl = ? AND json_extract(pk, '$.lid') = ?`,
    args: [uuid, t.tbl, Number(hit.id)],
  });
  return Number(hit.id);
}

async function deleteDependents(x: Exec, t: SyncTable, lid: number): Promise<void> {
  if (t.tbl === 'tags') {
    await x.execute({ sql: 'DELETE FROM transaction_tags WHERE tag_id = ?', args: [lid] });
    await x.execute({ sql: 'DELETE FROM tag_rules WHERE tag_id = ?', args: [lid] });
    await x.execute({ sql: 'DELETE FROM tag_rule_suppressions WHERE tag_id = ?', args: [lid] });
  }
}

async function applyCoOwned(x: Exec, ctx: MemberCtx, op: RemoteOp, stats: ApplyStats): Promise<void> {
  const t = SYNC_TABLES[op.tbl];
  if (!t || (t.kind === 'annotation' && op.tbl !== 'transactions')) { stats.skipped++; return; }
  if (await one(x, 'SELECT 1 AS x FROM _oplog WHERE op_id = ?', [op.op_id])) return; // known (own echo / duplicate)

  const r = await resolve(x, t, op, ctx);
  if (!r) { stats.skipped++; return; }
  const h = op.hlc;

  if (op.kind === 'delete') {
    const floor = await anyFloor(x, t, r.pk);
    if (floor != null && floor > h) { stats.superseded++; await logRemote(x, op, r.pk); return; }
    // Our older pending ops on this row are void.
    const id = oplogIdent(t, r.pk);
    await x.execute({
      sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'superseded'
            WHERE rowid IN (SELECT o.rowid FROM _oplog o WHERE o.tbl = ? AND o.pushed IN (${OP_PENDING}, ${OP_HELD}) AND o.hlc < ? AND ${id.where})`,
      args: [t.tbl, h, ...id.args],
    });
    if (t.kind === 'link') {
      if (r.args[1] !== -1) await x.execute({ sql: `DELETE FROM ${t.tbl} WHERE ${r.where}`, args: r.args });
    } else if (t.kind === 'annotation') {
      // The server never deletes transactions through this path.
    } else {
      const row = await one(x, `SELECT ${t.kind === 'uuid' ? 'id' : t.keyCols[0]} AS k FROM ${t.tbl} WHERE ${r.where}`, r.args);
      if (row) {
        if (t.kind === 'uuid') await deleteDependents(x, t, Number(row.k));
        await x.execute({ sql: `DELETE FROM ${t.tbl} WHERE ${r.where}`, args: r.args });
        if (t.tbl === 'category_rules') stats.touchedCategoryRules = true;
        if (t.tbl === 'name_rules') stats.touchedNameRules = true;
      }
    }
    await logRemote(x, op, r.pk);
    stats.applied++;
    return;
  }

  // upsert
  const fields = (op.fields ?? {}) as Record<string, unknown>;
  const del = await deleteFloor(x, t, r.pk);
  if (del != null && del > h) {
    stats.superseded += Math.max(1, Object.keys(fields).length);
    await logRemote(x, op, r.pk);
    return;
  }
  if (del != null) {
    // Newer than our delete: the row comes back; our delete is void.
    const id = oplogIdent(t, r.pk);
    await x.execute({
      sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'superseded'
            WHERE rowid IN (SELECT o.rowid FROM _oplog o WHERE o.tbl = ? AND o.kind = 'delete' AND o.pushed IN (${OP_PENDING}, ${OP_HELD}) AND o.hlc < ? AND ${id.where})`,
      args: [t.tbl, h, ...id.args],
    });
    stats.superseded++;
  }

  // Locate (or adopt / create) the local row.
  let exists = (await one(x, `SELECT 1 AS x FROM ${t.tbl} WHERE ${r.where}`, r.args)) != null;
  if (!exists && t.kind === 'uuid') {
    const lid = await adoptByNaturalKey(x, t, String(op.pk.id), fields);
    if (lid != null) { exists = true; r.pk.lid = lid; }
  }

  if (op.hlc === '') {
    // Bootstrap snapshot: the server's existing row beats our backfilled copy of it.
    const id = oplogIdent(t, r.pk);
    await x.execute({
      sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'server_wins'
            WHERE rowid IN (SELECT o.rowid FROM _oplog o WHERE o.tbl = ? AND o.origin = 'backfill' AND o.pushed = ${OP_PENDING} AND ${id.where})`,
      args: [t.tbl, ...id.args],
    });
  }

  const win: Record<string, unknown> = {};
  for (const f of t.fields) {
    if (!(f in fields)) continue;
    const floor = await fieldFloor(x, t, r.pk, f);
    if (floor == null || h > floor) win[f] = fields[f];
    else stats.superseded++;
  }

  if (!exists) {
    if (t.kind === 'annotation') { await logRemote(x, op, r.pk); stats.applied++; return; } // row not pulled yet: replayed on insert
    // A partial update cannot create a row: required columns are missing.
    const complete = t.fields.every((f) => f in fields);
    if (!complete) { stats.superseded++; await logRemote(x, op, r.pk); return; }
    await insertRow(x, t, r, op, fields);
    if (t.tbl === 'category_rules') stats.touchedCategoryRules = true;
    if (t.tbl === 'name_rules') stats.touchedNameRules = true;
    if (t.kind === 'uuid') {
      const row = await one(x, `SELECT id FROM ${t.tbl} WHERE uuid = ?`, [String(op.pk.id)]);
      r.pk.lid = row ? Number(row.id) : null;
    }
  } else if (Object.keys(win).length > 0) {
    let target = r.where; let targetArgs = r.args;
    await x.execute({
      sql: `UPDATE ${t.tbl} SET ${Object.keys(win).map((f) => `${f} = ?`).join(', ')} WHERE ${target}`,
      args: [...Object.keys(win).map((f) => arg(win[f])), ...targetArgs],
    });
    if (t.tbl === 'category_rules') stats.touchedCategoryRules = true;
    if (t.tbl === 'name_rules') stats.touchedNameRules = true;
    if (t.tbl === 'transactions') stats.touchedTransactions = true;
  }

  if (Object.keys(win).length > 0) await supersedeLocal(x, t, r.pk, Object.keys(win), h, stats);
  await logRemote(x, op, r.pk);
  stats.applied++;
}

async function insertRow(x: Exec, t: SyncTable, r: Resolved, op: RemoteOp, fields: Record<string, unknown>): Promise<void> {
  const cols: string[] = [];
  const vals: Arg[] = [];
  if (t.kind === 'uuid') { cols.push('uuid'); vals.push(String(op.pk.id)); }
  else if (t.kind === 'link') {
    // transaction_tags has an FK to transactions and tags: skip what we do not hold.
    if (r.args[1] === -1) return;
    if (!(await one(x, 'SELECT 1 AS x FROM transactions WHERE id = ?', [r.args[0]]))) return;
    cols.push('transaction_id', 'tag_id'); vals.push(r.args[0], r.args[1]);
  } else {
    for (let i = 0; i < t.keyCols.length; i++) { cols.push(t.keyCols[i]); vals.push(arg(Object.values(r.pk)[i])); }
  }
  for (const f of t.fields) { if (f in fields) { cols.push(f); vals.push(arg(fields[f])); } }
  await x.execute({
    sql: `INSERT OR REPLACE INTO ${t.tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    args: vals,
  });
}

// ── Server-owned tables ──────────────────────────────────────────────────────

async function replayAnnotations(x: Exec, txId: string, stats: ApplyStats): Promise<void> {
  // Annotation ops that arrived before the row did: apply the newest per field.
  const ops = await all(x,
    `SELECT fields, hlc FROM _oplog WHERE tbl = 'transactions' AND kind = 'upsert'
        AND pushed IN (${OP_PENDING}, ${OP_DONE}, ${OP_HELD}) AND json_extract(pk, '$.id') = ? ORDER BY hlc`, [txId]);
  const latest: Record<string, unknown> = {};
  for (const o of ops) Object.assign(latest, o.fields ? JSON.parse(String(o.fields)) : {});
  const cols = Object.keys(latest).filter((c) => SYNC_TABLES.transactions.fields.includes(c));
  if (cols.length === 0) return;
  await x.execute({
    sql: `UPDATE transactions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    args: [...cols.map((c) => arg(latest[c])), txId],
  });
  stats.touchedTransactions = true;
}

async function applyServerUpsert(x: Exec, op: RemoteOp, stats: ApplyStats): Promise<void> {
  const f = (op.fields ?? {}) as Record<string, unknown>;
  const id = String(op.pk.id ?? '');
  switch (op.tbl) {
    case 'accounts': {
      // Preserves local-only columns (nickname, owner, apr, excluded).
      await x.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, subtype = excluded.subtype,
                institution_name = excluded.institution_name, mask = excluded.mask`,
        args: [id, arg(f.name) ?? '', arg(f.type) ?? 'other', arg(f.subtype), arg(f.institution_name), arg(f.mask)],
      });
      break;
    }
    case 'balance_history': {
      await x.execute({
        sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
              ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`,
        args: [String(f.account_id ?? op.pk.account_id), arg(f.balance), dateOnly(f.date ?? op.pk.date)],
      });
      break;
    }
    case 'transactions': {
      stats.touchedTransactions = true;
      if (f.removed === true || f.removed === 1) {
        await x.execute({ sql: 'DELETE FROM transaction_tags WHERE transaction_id = ?', args: [id] });
        await x.execute({ sql: 'DELETE FROM tag_rule_suppressions WHERE transaction_id = ?', args: [id] });
        await x.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [id] });
        await x.execute({ sql: `UPDATE _oplog SET pushed = 4, reason = 'removed' WHERE pushed IN (0, 2) AND tbl IN ('transactions') AND json_extract(pk, '$.id') = ?`, args: [id] });
        await x.execute({ sql: `UPDATE _oplog SET pushed = 4, reason = 'removed' WHERE pushed IN (0, 2) AND tbl = 'transaction_tags' AND json_extract(pk, '$.transaction_id') = ?`, args: [id] });
        await x.execute({ sql: 'DELETE FROM _sync_server_tx WHERE id = ?', args: [id] });
        break;
      }
      const had = (await one(x, 'SELECT 1 AS x FROM transactions WHERE id = ?', [id])) != null;
      await x.execute({
        sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, pending, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'plaid')
              ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, date = excluded.date, name = excluded.name,
                merchant_name = excluded.merchant_name, amount = excluded.amount, category = excluded.category,
                raw_category = excluded.raw_category, pending = excluded.pending`,
        args: [id, String(f.account_id), dateOnly(f.date), String(f.name ?? ''), arg(f.merchant_name), Number(f.amount ?? 0),
               arg(f.category), arg(f.raw_category), arg(f.pending) ?? 0],
      });
      await x.execute({ sql: 'INSERT OR IGNORE INTO _sync_server_tx (id) VALUES (?)', args: [id] });
      // Annotation columns carried by the row (bootstrap snapshot) apply where
      // we hold nothing newer for them.
      for (const col of SYNC_TABLES.transactions.fields) {
        if (!(col in f)) continue;
        if ((await fieldFloor(x, SYNC_TABLES.transactions, { id }, col)) != null) continue;
        if (f[col] == null && !had) continue;
        await x.execute({ sql: `UPDATE transactions SET ${col} = ? WHERE id = ?`, args: [arg(f[col]), id] });
      }
      if (!had) await replayAnnotations(x, id, stats);
      break;
    }
    default: stats.skipped++; return;
  }
  stats.applied++;
}

export function isServerOwned(tbl: string): boolean {
  return (SERVER_OWNED_TABLES as readonly string[]).includes(tbl);
}

/** Apply one remote op. Never throws for a bad op: it is counted as skipped. */
export async function applyRemoteOp(x: Exec, ctx: MemberCtx, op: RemoteOp, stats: ApplyStats): Promise<void> {
  try {
    if (op.kind === 'server_upsert') {
      if (!isServerOwned(op.tbl)) { stats.skipped++; return; }
      await applyServerUpsert(x, op, stats);
      return;
    }
    if (isServerOwned(op.tbl) && op.tbl !== 'transactions') { stats.skipped++; return; }
    await applyCoOwned(x, ctx, op, stats);
  } catch (e) {
    stats.skipped++;
    console.error(`[sync] could not apply ${op.tbl} op ${op.op_id}:`, e instanceof Error ? e.message : e);
  }
}

// ── Bootstrap snapshot (GET /sync/pull) ──────────────────────────────────────

export type SnapshotTables = Record<string, { rows: Row[]; deletes?: unknown[] } | undefined>;

const SNAPSHOT_ORDER = [
  'accounts', 'transactions', 'balance_history',
  'categories', 'settings', 'hidden_categories', 'household_members',
  'tags', 'category_rules', 'name_rules', 'transaction_tags',
] as const;

/** Turn a snapshot into ops with the lowest possible HLC (local edits win). */
export function snapshotOps(tables: SnapshotTables): RemoteOp[] {
  const out: RemoteOp[] = [];
  const mk = (tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>, kind: RemoteOp['kind']) =>
    out.push({ op_id: `snapshot:${tbl}:${JSON.stringify(pk)}`, tbl, pk, kind, fields, hlc: '' });
  for (const tbl of SNAPSHOT_ORDER) {
    const d = tables[tbl];
    if (!d) continue;
    for (const r of d.rows) {
      if (tbl === 'accounts') { mk(tbl, { id: r.id }, r, 'server_upsert'); continue; }
      if (tbl === 'transactions') {
        mk(tbl, { id: r.id }, { ...r, removed: Boolean(r.removed) }, 'server_upsert');
        continue;
      }
      if (tbl === 'balance_history') { mk(tbl, { account_id: r.account_id, date: dateOnly(r.date) }, r, 'server_upsert'); continue; }
      const t = SYNC_TABLES[tbl];
      const pk = t.kind === 'link' ? { transaction_id: r.transaction_id, tag_id: r.tag_id }
        : t.kind === 'uuid' ? { id: r.id } : Object.fromEntries(t.keyCols.map((c) => [c, r[c]]));
      mk(tbl, pk, Object.fromEntries(t.fields.map((f) => [f, r[f] ?? null])), 'upsert');
    }
  }
  return out;
}
