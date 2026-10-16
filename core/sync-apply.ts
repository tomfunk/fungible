import type { Client } from '@libsql/client';
import { deriveMemberUuid } from './sync-ids.js';
import {
  SYNC_TABLES, SERVER_OWNED_TABLES, CLIENT_TABLES, ACCOUNT_WIRE_PREFIX, CSV_DERIVED_GLOB, isClientTxId, isSyncedSetting,
  type SyncTable,
} from './sync-spec.js';
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
    : t.kind === 'link' ? ['transaction_id', 'tag_id'] : t.keyCols; // 'client' uses its own keyCols
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
      try { // column exists once hosted sync is enabled
        await x.execute({ sql: `UPDATE accounts SET origin = 'plaid' WHERE id = ? AND origin IS NULL`, args: [id] });
      } catch { /* pre-migration schema */ }
      break;
    }
    case 'balance_history': {
      await x.execute({
        sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
              ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`,
        args: [await localAccountId(x, String(f.account_id ?? op.pk.account_id)), arg(f.balance), dateOnly(f.date ?? op.pk.date)],
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

// ── Client-owned rows (CSV / manual accounts, transactions, balances) ────────

/** Local account id for a wire account id (Plaid ids are the same on both sides). */
export async function localAccountId(x: Exec, wire: string): Promise<string> {
  try {
    const r = await one(x, 'SELECT id FROM accounts WHERE wire_id = ? OR id = ? ORDER BY (wire_id = ?) DESC LIMIT 1', [wire, wire, wire]);
    return r ? String(r.id) : wire;
  } catch { return wire; } // pre-migration schema: no wire_id column
}

/** Local id a pulled client account gets: a shape the UIs already recognise. */
export function localIdForWireAccount(wire: string, subtype: unknown): string {
  const uuid = wire.slice(ACCOUNT_WIRE_PREFIX.length);
  return subtype === 'manual' ? `manual-${uuid}` : `csv-acct-${uuid}`;
}

const isClientOp = (op: RemoteOp): boolean =>
  (op.kind === 'upsert' || op.kind === 'delete') && (
    op.tbl === 'accounts' || op.tbl === 'balance_history' || op.tbl === 'imports' ||
    (op.tbl === 'transactions' && isClientTxId(String(op.pk.id ?? ''))));

async function deleteAccountCascade(x: Exec, localId: string): Promise<void> {
  const A = (sql: string) => x.execute({ sql, args: [localId] });
  await A('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)');
  await A('DELETE FROM tag_rule_suppressions WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)');
  await A('DELETE FROM transactions WHERE account_id = ?');
  await A('DELETE FROM balance_history WHERE account_id = ?');
  await A('DELETE FROM category_rules WHERE account_id = ?');
  await A('DELETE FROM name_rules WHERE account_id = ?');
  await A('DELETE FROM imports WHERE account_id = ?');
  await A('DELETE FROM sync_state WHERE account_id = ?');
  await A('DELETE FROM accounts WHERE id = ?');
}

interface ClientResolved { pk: Record<string, unknown>; where: string; args: Arg[]; accountLocal?: string }

async function resolveClient(x: Exec, op: RemoteOp): Promise<ClientResolved | null> {
  const f = (op.fields ?? {}) as Record<string, unknown>;
  switch (op.tbl) {
    case 'accounts': {
      const wire = String(op.pk.id ?? '');
      if (!wire.startsWith(ACCOUNT_WIRE_PREFIX)) return null;
      const hit = await one(x, 'SELECT id FROM accounts WHERE wire_id = ? OR id = ? LIMIT 1', [wire, wire]);
      const local = hit ? String(hit.id) : localIdForWireAccount(wire, f.subtype);
      return { pk: { id: local, wire }, where: 'id = ?', args: [local] };
    }
    case 'transactions': {
      const id = String(op.pk.id);
      return { pk: { id }, where: 'id = ?', args: [id] };
    }
    case 'imports': {
      const wire = String(op.pk.id ?? '');
      const hit = await one(x, 'SELECT id FROM imports WHERE wire_id = ?', [wire]);
      const local = hit ? Number(hit.id) : null;
      return { pk: { id: local, wire }, where: 'id = ?', args: [local] };
    }
    case 'balance_history': {
      const wire = String(op.pk.account_id ?? '');
      const local = await localAccountId(x, wire);
      const date = dateOnly(op.pk.date);
      return { pk: { account_id: local, date }, where: 'account_id = ? AND date = ?', args: [local, date], accountLocal: local };
    }
    default: return null;
  }
}

async function applyClientOp(x: Exec, op: RemoteOp, stats: ApplyStats): Promise<void> {
  const t = CLIENT_TABLES[op.tbl];
  if (!t) { stats.skipped++; return; }
  if (await one(x, 'SELECT 1 AS x FROM _oplog WHERE op_id = ?', [op.op_id])) return; // own echo / duplicate
  const r = await resolveClient(x, op);
  if (!r) { stats.skipped++; return; }
  const h = op.hlc;
  const id = oplogIdent(t, r.pk);
  const supersedePending = (kindClause: string) => x.execute({
    sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'superseded'
          WHERE rowid IN (SELECT o.rowid FROM _oplog o WHERE o.tbl = ? ${kindClause} AND o.pushed IN (${OP_PENDING}, ${OP_HELD})
                            AND o.hlc < ? AND ${id.where})`,
    args: [t.tbl, h, ...id.args],
  });

  if (op.kind === 'delete') {
    const floor = await anyFloor(x, t, r.pk);
    if (floor != null && floor > h) { stats.superseded++; await logRemote(x, op, r.pk); return; }
    await supersedePending('');
    if (op.tbl === 'accounts') {
      await deleteAccountCascade(x, String(r.pk.id));
      stats.touchedTransactions = true;
    } else if (op.tbl === 'transactions') {
      await x.execute({ sql: 'DELETE FROM transaction_tags WHERE transaction_id = ?', args: [String(r.pk.id)] });
      await x.execute({ sql: 'DELETE FROM tag_rule_suppressions WHERE transaction_id = ?', args: [String(r.pk.id)] });
      await x.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [String(r.pk.id)] });
      stats.touchedTransactions = true;
    } else if (op.tbl === 'imports') {
      // Undo import: the rows it brought go with it.
      if (r.pk.id != null) {
        const iid = Number(r.pk.id);
        await x.execute({ sql: `DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)`, args: [iid] });
        await x.execute({ sql: `DELETE FROM tag_rule_suppressions WHERE transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)`, args: [iid] });
        await x.execute({ sql: 'DELETE FROM transactions WHERE import_id = ?', args: [iid] });
        await x.execute({ sql: 'DELETE FROM imports WHERE id = ?', args: [iid] });
        stats.touchedTransactions = true;
      }
    } else {
      await x.execute({ sql: `DELETE FROM balance_history WHERE ${r.where}`, args: r.args });
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
  if (del != null) { await supersedePending(`AND o.kind = 'delete'`); stats.superseded++; }

  if (op.hlc === '') {
    // Snapshot row: the server's copy beats our backfilled copy of it.
    await x.execute({
      sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'server_wins'
            WHERE rowid IN (SELECT o.rowid FROM _oplog o WHERE o.tbl = ? AND o.origin = 'backfill' AND o.pushed = ${OP_PENDING} AND ${id.where})`,
      args: [t.tbl, ...id.args],
    });
  }

  let exists = r.args[0] != null && (await one(x, `SELECT 1 AS x FROM ${t.tbl} WHERE ${r.where}`, r.args)) != null;
  if (!exists && op.tbl === 'transactions') exists = await adoptCsvTwin(x, r, fields);
  const win: Record<string, unknown> = {};
  for (const fld of t.fields) {
    if (!(fld in fields)) continue;
    const floor = await fieldFloor(x, t, r.pk, fld);
    if (floor == null || h > floor) win[fld] = fields[fld];
    else stats.superseded++;
  }
  // Account references come in wire form.
  if (op.tbl === 'transactions' && 'account_id' in win) win.account_id = await localAccountId(x, String(win.account_id));
  if (op.tbl === 'transactions' && 'import_id' in win) win.import_id = await localImportId(x, win.import_id);
  if (op.tbl === 'imports' && 'account_id' in win) win.account_id = await localAccountId(x, String(win.account_id));
  delete win.source; // immutable after insert

  if (!exists) {
    const ins = await insertClientRow(x, op, r, fields, win);
    if (!ins) { stats.skipped++; return; }
    if (op.tbl === 'transactions') stats.touchedTransactions = true;
    if (op.tbl === 'imports') r.pk.id = (await one(x, 'SELECT id FROM imports WHERE wire_id = ?', [String(r.pk.wire)]))?.id ?? null;
  } else {
    const keys = Object.keys(win);
    if (keys.length > 0) {
      await x.execute({
        sql: `UPDATE ${t.tbl} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${r.where}`,
        args: [...keys.map((k) => arg(win[k])), ...r.args],
      });
      if (op.tbl === 'transactions') stats.touchedTransactions = true;
    }
  }
  if (Object.keys(win).length > 0) await supersedeLocal(x, t, r.pk, Object.keys(win), h, stats);
  await logRemote(x, op, r.pk);
  stats.applied++;
}

async function localImportId(x: Exec, wire: unknown): Promise<number | null> {
  if (wire == null) return null;
  const r = await one(x, 'SELECT id FROM imports WHERE wire_id = ?', [String(wire)]);
  return r ? Number(r.id) : null;
}

/**
 * A pulled CSV row whose (account, dedup_key) is already held under another id
 * (a legacy id this device had not re-keyed yet) IS that row: take the wire id.
 */
async function adoptCsvTwin(x: Exec, r: ClientResolved, fields: Record<string, unknown>): Promise<boolean> {
  if (fields.account_id == null || fields.dedup_key == null) return false;
  const account = await localAccountId(x, String(fields.account_id));
  const twin = await one(x, 'SELECT id FROM transactions WHERE account_id = ? AND dedup_key = ? AND id != ?',
    [account, String(fields.dedup_key), String(r.pk.id)]);
  if (!twin) return false;
  const old = String(twin.id);
  const next = String(r.pk.id);
  await x.execute({ sql: 'UPDATE transactions SET id = ? WHERE id = ?', args: [next, old] });
  await x.execute({ sql: 'UPDATE transaction_tags SET transaction_id = ? WHERE transaction_id = ?', args: [next, old] });
  await x.execute({ sql: 'UPDATE tag_rule_suppressions SET transaction_id = ? WHERE transaction_id = ?', args: [next, old] });
  await x.execute({
    sql: `UPDATE _oplog SET pushed = ${OP_SUPERSEDED}, reason = 'adopted' WHERE pushed IN (${OP_PENDING}, ${OP_HELD})
          AND kind = 'upsert' AND tbl = 'transactions' AND json_extract(pk, '$.id') IN (?, ?)`,
    args: [old, next],
  });
  return true;
}

/** Create a pulled client row. False when it cannot be created (partial op, unknown parent). */
async function insertClientRow(
  x: Exec, op: RemoteOp, r: ClientResolved, fields: Record<string, unknown>, win: Record<string, unknown>,
): Promise<boolean> {
  // Only a complete op (or the snapshot's whole row) can create a row.
  const full: Record<string, unknown> = { ...fields, ...win };
  if (op.tbl === 'accounts') {
    if (full.name == null || full.type == null) return false;
    await x.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype, institution_name, mask, nickname, owner, apr, excluded, origin, wire_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', ?)`,
      args: [String(r.pk.id), String(full.name), String(full.type), arg(full.subtype), arg(full.institution_name),
             arg(full.mask), arg(full.nickname), arg(full.owner), arg(full.apr), arg(full.excluded) ?? 0, String(r.pk.wire)],
    });
    return true;
  }
  if (op.tbl === 'balance_history') {
    if (full.balance == null || !(await one(x, 'SELECT 1 AS x FROM accounts WHERE id = ?', [r.accountLocal ?? '']))) return false;
    await x.execute({
      sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
            ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`,
      args: [r.accountLocal!, Number(full.balance), String(r.pk.date)],
    });
    return true;
  }
  if (op.tbl === 'imports') {
    const account = full.account_id == null ? null : await localAccountId(x, String(full.account_id));
    if (account == null || full.file_hash == null || full.file_name == null
        || !(await one(x, 'SELECT 1 AS x FROM accounts WHERE id = ?', [account]))) return false;
    const rowCount = Number(full.row_count ?? 0);
    await x.execute({
      sql: `INSERT INTO imports (account_id, file_name, file_hash, imported_at, row_count, imported, skipped, min_date, max_date, config, wire_id)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', ?)`,
      args: [account, String(full.file_name), String(full.file_hash), Number(full.imported_at ?? Date.now()), rowCount, rowCount,
             arg(full.min_date), arg(full.max_date), String(r.pk.wire)],
    });
    return true;
  }
  // transactions
  const accountLocal = full.account_id == null ? null : await localAccountId(x, String(full.account_id));
  const source = fields.source ?? full.source;
  if (accountLocal == null || full.date == null || full.name == null || full.amount == null || source == null) return false;
  if (!(await one(x, 'SELECT 1 AS x FROM accounts WHERE id = ?', [accountLocal]))) return false;
  await x.execute({
    sql: `INSERT INTO transactions
            (id, account_id, date, name, merchant_name, amount, category, raw_category, pending, manual_category,
             display_name, ignored, original_date, source, import_id, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    args: [String(r.pk.id), accountLocal, dateOnly(full.date), String(full.name), arg(full.merchant_name), Number(full.amount),
           arg(full.manual_category), arg(full.raw_category), arg(full.manual_category), arg(full.display_name),
           arg(full.ignored) ?? 0, arg(full.original_date), String(source), await localImportId(x, fields.import_id),
           arg(full.dedup_key)],
  });
  return true;
}

/**
 * After a full snapshot: local client rows the server acknowledged earlier but
 * no longer lists were deleted elsewhere (the snapshot omits tombstones).
 * Rows with a pending or held local op are kept.
 */
export async function pruneVanishedClientRows(x: Exec, tables: SnapshotTables): Promise<number> {
  const ids = (tbl: string, col: string) => new Set((tables[tbl]?.rows ?? []).map((r) => String(r[col])));
  const accounts = ids('accounts', 'id');
  const txs = ids('transactions', 'id');
  const balances = new Set((tables.balance_history?.rows ?? []).map((r) => `${r.account_id}|${dateOnly(r.date)}`));
  let n = 0;
  const hasOp = async (tbl: string, pkCol: string, key: string, states: string): Promise<boolean> =>
    (await one(x,
      `SELECT 1 AS x FROM _oplog WHERE tbl = ? AND json_extract(pk, '$.${pkCol}') = ? AND pushed IN (${states})`,
      [tbl, key])) != null;
  const open = OP_PENDING + ', ' + OP_HELD;

  for (const a of await all(x, `SELECT id, wire_id FROM accounts WHERE wire_id IS NOT NULL AND origin = 'client'`)) {
    const local = String(a.id);
    if (accounts.has(String(a.wire_id))) continue;
    if (await hasOp('accounts', 'id', local, open) || !(await hasOp('accounts', 'id', local, String(OP_DONE)))) continue;
    await deleteAccountCascade(x, local);
    n++;
  }
  const importIds = ids('imports', 'id');
  for (const i of await all(x, `SELECT id, wire_id FROM imports WHERE wire_id IS NOT NULL`)) {
    const local = String(i.id);
    if (importIds.has(String(i.wire_id))) continue;
    if (await hasOp('imports', 'id', local, open) || !(await hasOp('imports', 'id', local, String(OP_DONE)))) continue;
    await x.execute({ sql: 'UPDATE transactions SET import_id = NULL WHERE import_id = ?', args: [Number(local)] });
    await x.execute({ sql: 'DELETE FROM imports WHERE id = ?', args: [Number(local)] });
    n++;
  }
  for (const t of await all(x,
    `SELECT id FROM transactions WHERE source IN ('manual', 'csv') AND (id LIKE 'manual-%' OR id GLOB '${CSV_DERIVED_GLOB}')`)) {
    const id = String(t.id);
    if (txs.has(id)) continue;
    if (await hasOp('transactions', 'id', id, open) || !(await hasOp('transactions', 'id', id, String(OP_DONE)))) continue;
    await x.execute({ sql: 'DELETE FROM transaction_tags WHERE transaction_id = ?', args: [id] });
    await x.execute({ sql: 'DELETE FROM tag_rule_suppressions WHERE transaction_id = ?', args: [id] });
    await x.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [id] });
    n++;
  }
  for (const b of await all(x,
    `SELECT b.account_id, b.date, a.wire_id FROM balance_history b JOIN accounts a ON a.id = b.account_id
      WHERE a.origin = 'client' AND a.wire_id IS NOT NULL`)) {
    if (balances.has(`${b.wire_id}|${b.date}`)) continue;
    const q = (states: string) => one(x,
      `SELECT 1 AS x FROM _oplog WHERE tbl = 'balance_history' AND json_extract(pk, '$.account_id') = ?
          AND json_extract(pk, '$.date') = ? AND pushed IN (${states})`, [String(b.account_id), String(b.date)]);
    if ((await q(open)) || !(await q(String(OP_DONE)))) continue;
    await x.execute({ sql: 'DELETE FROM balance_history WHERE account_id = ? AND date = ?', args: [String(b.account_id), String(b.date)] });
    n++;
  }
  return n;
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
    if (isClientOp(op)) { await applyClientOp(x, op, stats); return; }
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
  'accounts', 'imports', 'transactions', 'balance_history',
  'categories', 'settings', 'hidden_categories', 'household_members',
  'tags', 'category_rules', 'name_rules', 'transaction_tags',
] as const;

/** Turn a snapshot into ops with the lowest possible HLC (local edits win). */
export function snapshotOps(tables: SnapshotTables): RemoteOp[] {
  const out: RemoteOp[] = [];
  const mk = (tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>, kind: RemoteOp['kind']) =>
    out.push({ op_id: `snapshot:${tbl}:${JSON.stringify(pk)}`, tbl, pk, kind, fields, hlc: '' });
  // Client-owned accounts (and their balances) are recognised by origin.
  const clientAccounts = new Set(
    (tables.accounts?.rows ?? []).filter((a) => a.origin === 'client').map((a) => String(a.id)));
  for (const tbl of SNAPSHOT_ORDER) {
    const d = tables[tbl];
    if (!d) continue;
    for (const r of d.rows) {
      if (tbl === 'accounts') {
        mk(tbl, { id: r.id }, r, r.origin === 'client' ? 'upsert' : 'server_upsert');
        continue;
      }
      if (tbl === 'imports') { mk(tbl, { id: r.id }, r, 'upsert'); continue; }
      if (tbl === 'transactions') {
        const client = r.source === 'csv' || r.source === 'manual';
        mk(tbl, { id: r.id }, client ? r : { ...r, removed: Boolean(r.removed) }, client ? 'upsert' : 'server_upsert');
        continue;
      }
      if (tbl === 'balance_history') {
        mk(tbl, { account_id: r.account_id, date: dateOnly(r.date) }, r,
          clientAccounts.has(String(r.account_id)) ? 'upsert' : 'server_upsert');
        continue;
      }
      const t = SYNC_TABLES[tbl];
      const pk = t.kind === 'link' ? { transaction_id: r.transaction_id, tag_id: r.tag_id }
        : t.kind === 'uuid' ? { id: r.id } : Object.fromEntries(t.keyCols.map((c) => [c, r[c]]));
      mk(tbl, pk, Object.fromEntries(t.fields.map((f) => [f, r[f] ?? null])), 'upsert');
    }
  }
  return out;
}
