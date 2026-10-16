import type { Client, InStatement } from '@libsql/client';
import { formatHlc, tickHlc, type HlcState } from './hlc.js';
import {
  SYNC_TABLES, SYNCED_SETTINGS_SQL_LIST, CLIENT_ACCOUNT_FIELDS, CLIENT_TX_FIELDS, CLIENT_TX_BODY_FIELDS,
  CLIENT_IMPORT_FIELDS,
  clientAccountSql, type SyncTable,
} from './sync-spec.js';

// The local operation log and the SQLite triggers that fill it. Portable: no
// node:* imports (PR4's browser DB uses this unchanged).
//
// Why triggers: product code writes the synced tables with plain SQL, from any
// process (TUI, GUI, MCP server, the engine itself). A trigger sees every such
// write, so no call site needs a hook and a write can never be missed.
//
// Installed ONLY by enableHostedMode (through migrate(), after a snapshot).
// After the first enable they stay installed and keep logging even while the
// install is back in BYOK mode, so edits made then push on re-entry. A BYOK
// database that never enabled sync has none of this.
//
// Local pk shapes (the wire shapes are produced at push time, see SYNC_PROTOCOL.md):
//   natural / annotation   {col: value, ...}
//   uuid                   {"lid": <local integer id>, "id": <uuid or null>}
//                          `id` is null until the engine assigns the derived uuid;
//                          the engine patches pending ops when it does.
//   link                   {"transaction_id", "tag_id": <tag uuid or null>, "tag_lid"}
//
// `_oplog.pushed`: 0 pending, 1 acknowledged / remote, 2 held (local-only row,
// not sendable), 3 permanently rejected, 4 moot (target never reached the
// server), 5 superseded by a newer HLC.

export const OP_PENDING = 0;
export const OP_DONE = 1;
export const OP_HELD = 2;
export const OP_REJECTED = 3;
export const OP_MOOT = 4;
export const OP_SUPERSEDED = 5;

export const OPLOG_MIGRATION_VERSION = 2;
/** Client-owned accounts / transactions / balances (see installClientOwnedStatements). */
export const CLIENT_OWNED_MIGRATION_VERSION = 3;
/** Synced imports + CSV rows (installImportsStatements). */
export const IMPORTS_MIGRATION_VERSION = 4;

const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
const APPLYING_OFF = `NOT EXISTS (SELECT 1 FROM _sync_state WHERE key = 'applying' AND value = '1')`;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function jsonObj(prefix: 'NEW' | 'OLD', cols: string[]): string {
  if (cols.length === 0) return `'{}'`;
  return `json_object(${cols.map((c) => `${q(c)}, ${prefix}.${c}`).join(', ')})`;
}

function pkExpr(t: SyncTable, p: 'NEW' | 'OLD'): string {
  if (t.kind === 'uuid') return `json_object('lid', ${p}.id, 'id', ${p}.uuid)`;
  if (t.kind === 'link') {
    return `json_object('transaction_id', ${p}.transaction_id, 'tag_id', (SELECT uuid FROM tags WHERE id = ${p}.tag_id), 'tag_lid', ${p}.tag_id)`;
  }
  return jsonObj(p, t.keyCols);
}

function changedFields(t: SyncTable, cols: string[] = t.fields): string {
  return `(SELECT json_group_object(k, v) FROM (${cols
    .map((c, i) => `${i ? 'UNION ALL ' : ''}SELECT ${q(c)} AS k, NEW.${c} AS v WHERE OLD.${c} IS NOT NEW.${c}`)
    .join(' ')}))`;
}

const anyChanged = (cols: string[]) => cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');

/** The two statements that append one op: advance the HLC, then insert. */
function logOp(tbl: string, kind: 'upsert' | 'delete', pk: string, fields: string | null, guard = ''): string {
  const tick =
    `UPDATE _hlc SET counter = CASE WHEN wall >= ${NOW_MS} THEN counter + 1 ELSE 0 END, wall = MAX(wall, ${NOW_MS}) WHERE id = 1;`;
  const ins =
    `INSERT INTO _oplog (op_id, tbl, pk, kind, fields, hlc, device_id) ` +
    `SELECT lower(hex(randomblob(16))), ${q(tbl)}, ${pk}, ${q(kind)}, ${fields ?? 'NULL'}, ` +
    `printf('%015d-%05d-%s', wall, counter, device_id), device_id FROM _hlc WHERE id = 1${guard};`;
  return `${tick} ${ins}`;
}

function trigger(name: string, event: string, when: string, body: string): string {
  return `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} WHEN ${when} BEGIN ${body} END`;
}

/** CREATE TRIGGER statements for one synced table. */
export function triggersFor(t: SyncTable): string[] {
  const n = (s: string) => `_sync_${t.tbl}_${s}`;
  const out: string[] = [];
  const settingsAllowed = (p: 'NEW' | 'OLD') => (t.tbl === 'settings' ? ` AND ${p}.key IN (${SYNCED_SETTINGS_SQL_LIST})` : '');
  const scopeNull = (p: 'NEW' | 'OLD') => (t.scopedBy ? ` AND ${p}.${t.scopedBy} IS NULL` : '');

  if (t.kind === 'annotation') {
    out.push(trigger(n('upd'), `UPDATE OF ${t.fields.join(', ')} ON ${t.tbl}`,
      `${APPLYING_OFF} AND (${anyChanged(t.fields)})`,
      logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), changedFields(t))));
    return out;
  }

  out.push(trigger(n('ins'), `INSERT ON ${t.tbl}`, `${APPLYING_OFF}${settingsAllowed('NEW')}${scopeNull('NEW')}`,
    logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), jsonObj('NEW', t.fields))));
  out.push(trigger(n('del'), `DELETE ON ${t.tbl}`, `${APPLYING_OFF}${settingsAllowed('OLD')}${scopeNull('OLD')}`,
    logOp(t.tbl, 'delete', pkExpr(t, 'OLD'), null)));
  if (t.kind === 'link') return out;

  if (t.kind === 'natural') {
    // Key change: the old key is deleted, the new one created in full.
    out.push(trigger(n('rekey'), `UPDATE OF ${t.keyCols.join(', ')} ON ${t.tbl}`,
      `${APPLYING_OFF} AND (${anyChanged(t.keyCols)})`,
      [
        t.tbl === 'settings'
          ? logOp(t.tbl, 'delete', pkExpr(t, 'OLD'), null, ` AND OLD.key IN (${SYNCED_SETTINGS_SQL_LIST})`)
          : logOp(t.tbl, 'delete', pkExpr(t, 'OLD'), null),
        t.tbl === 'settings'
          ? logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), jsonObj('NEW', t.fields), ` AND NEW.key IN (${SYNCED_SETTINGS_SQL_LIST})`)
          : logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), jsonObj('NEW', t.fields)),
      ].join(' ')));
  }
  if (t.fields.length > 0) {
    const keyUnchanged = t.kind === 'natural' ? ` AND NOT (${anyChanged(t.keyCols)})` : '';
    out.push(trigger(n('upd'), `UPDATE OF ${t.fields.join(', ')} ON ${t.tbl}`,
      `${APPLYING_OFF} AND (${anyChanged(t.fields)})${keyUnchanged}${settingsAllowed('NEW')}${scopeNull('OLD')}${scopeNull('NEW')}`,
      logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), changedFields(t))));
  }
  if (t.scopedBy) {
    const s = t.scopedBy;
    // Scoped to an account: local-only, so the server copy (if any) goes away.
    out.push(trigger(n('scope_out'), `UPDATE OF ${s} ON ${t.tbl}`,
      `${APPLYING_OFF} AND OLD.${s} IS NULL AND NEW.${s} IS NOT NULL`,
      logOp(t.tbl, 'delete', pkExpr(t, 'OLD'), null)));
    // Unscoped again: becomes a normal synced rule.
    out.push(trigger(n('scope_in'), `UPDATE OF ${s} ON ${t.tbl}`,
      `${APPLYING_OFF} AND OLD.${s} IS NOT NULL AND NEW.${s} IS NULL`,
      logOp(t.tbl, 'upsert', pkExpr(t, 'NEW'), jsonObj('NEW', t.fields))));
  }
  return out;
}

export const OPLOG_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS _sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _hlc (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     wall INTEGER NOT NULL,
     counter INTEGER NOT NULL,
     device_id TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS _oplog (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     op_id TEXT NOT NULL UNIQUE,
     tbl TEXT NOT NULL,
     pk TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
     fields TEXT,
     hlc TEXT NOT NULL,
     device_id TEXT NOT NULL,
     pushed INTEGER NOT NULL DEFAULT 0,
     origin TEXT,
     server_seq TEXT,
     reason TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS _oplog_pending ON _oplog (pushed, seq)`,
  `CREATE INDEX IF NOT EXISTS _oplog_ident ON _oplog (tbl, json_extract(pk, '$.id'), json_extract(pk, '$.name'), json_extract(pk, '$.key'), json_extract(pk, '$.category'))`,
  // Ids of server-owned transactions this install holds: only annotations on
  // these can be sent (the server has no other rows to attach them to).
  `CREATE TABLE IF NOT EXISTS _sync_server_tx (id TEXT PRIMARY KEY) WITHOUT ROWID`,
];

export interface OpInput {
  tbl: string;
  pk: Record<string, unknown>;
  kind: 'upsert' | 'delete';
  fields?: Record<string, unknown> | null;
  origin?: string | null;
}

/**
 * Statements that append ops with HLCs ticked in JS (backfill, adoption). The
 * clock row is raised, never lowered, so a trigger in another process that
 * advanced it meanwhile is not regressed.
 */
export async function queueOpsStatements(
  client: Pick<Client, 'execute'>,
  ops: OpInput[],
  nowMs: number = Date.now(),
): Promise<InStatement[]> {
  if (ops.length === 0) return [];
  const r = await client.execute('SELECT wall, counter, device_id FROM _hlc WHERE id = 1');
  const row = r.rows[0] as unknown as { wall: number; counter: number; device_id: string } | undefined;
  if (!row) throw new Error('sync clock row missing (_hlc)');
  let st: HlcState = { wall: Number(row.wall), counter: Number(row.counter) };
  const stmts: InStatement[] = [];
  for (const op of ops) {
    st = tickHlc(st, nowMs);
    stmts.push({
      sql: `INSERT INTO _oplog (op_id, tbl, pk, kind, fields, hlc, device_id, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        globalThis.crypto.randomUUID().replace(/-/g, ''), op.tbl, JSON.stringify(op.pk), op.kind,
        op.fields == null ? null : JSON.stringify(op.fields),
        formatHlc(st.wall, st.counter, String(row.device_id)), String(row.device_id), op.origin ?? null,
      ],
    });
  }
  stmts.push({
    sql: `UPDATE _hlc SET
            counter = CASE WHEN ? > wall THEN ? WHEN ? = wall AND ? > counter THEN ? ELSE counter END,
            wall = MAX(wall, ?) WHERE id = 1`,
    args: [st.wall, st.counter, st.wall, st.counter, st.counter, st.wall],
  });
  return stmts;
}

type Row = Record<string, unknown>;
const rowsOf = async (c: Pick<Client, 'execute'>, sql: string): Promise<Row[]> =>
  (await c.execute(sql)).rows as unknown as Row[];

async function tableExists(c: Pick<Client, 'execute'>, name: string): Promise<boolean> {
  const r = await c.execute({ sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, args: [name] });
  return r.rows.length > 0;
}

async function hasColumn(c: Pick<Client, 'execute'>, tbl: string, col: string): Promise<boolean> {
  return (await rowsOf(c, `PRAGMA table_info(${tbl})`)).some((r) => r.name === col);
}

/**
 * Upsert ops for every existing local row of a synced table, so the first
 * push uploads local state. Account-scoped rules and denied settings are
 * excluded (as are transactions: their annotations are queued by adoption,
 * once a local row is known to correspond to a server row).
 */
export async function collectBackfill(client: Pick<Client, 'execute'>): Promise<OpInput[]> {
  const present: Record<string, boolean> = {};
  for (const t of Object.keys(SYNC_TABLES)) present[t] = await tableExists(client, t);
  const ops: OpInput[] = [];
  const add = (tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>) =>
    ops.push({ tbl, pk, kind: 'upsert', fields, origin: 'backfill' });
  const pick = (r: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));

  if (present.categories) for (const r of await rowsOf(client, 'SELECT * FROM categories')) add('categories', { name: r.name }, pick(r, ['flexibility']));
  if (present.hidden_categories) for (const r of await rowsOf(client, 'SELECT * FROM hidden_categories')) add('hidden_categories', { category: r.category }, {});
  if (present.household_members) for (const r of await rowsOf(client, 'SELECT * FROM household_members')) add('household_members', { id: r.id }, pick(r, SYNC_TABLES.household_members.fields));
  if (present.settings) for (const r of await rowsOf(client, `SELECT * FROM settings WHERE key IN (${SYNCED_SETTINGS_SQL_LIST})`)) add('settings', { key: r.key }, pick(r, ['value']));
  if (present.tags) for (const r of await rowsOf(client, 'SELECT * FROM tags')) {
    add('tags', { lid: r.id, id: null }, pick(r, ['name']));
  }
  for (const tbl of ['category_rules', 'name_rules'] as const) {
    if (!present[tbl]) continue;
    for (const r of await rowsOf(client, `SELECT * FROM ${tbl} WHERE account_id IS NULL`)) {
      add(tbl, { lid: r.id, id: null }, pick(r, SYNC_TABLES[tbl].fields));
    }
  }
  if (present.transaction_tags && present.tags) {
    for (const r of await rowsOf(client, 'SELECT transaction_id, tag_id FROM transaction_tags')) {
      add('transaction_tags', { transaction_id: r.transaction_id, tag_id: null, tag_lid: r.tag_id }, {});
    }
  }
  return ops;
}

/**
 * Everything migration 2 does, as statements for migrate() to run atomically:
 * bookkeeping tables, uuid columns, triggers, and backfill ops so the first
 * push uploads existing local state. Account-scoped rules and denied settings
 * are excluded from the backfill (and their triggers never log them).
 */
export async function installStatements(
  client: Pick<Client, 'execute'>,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<InStatement[]> {
  const stmts: InStatement[] = [...OPLOG_DDL];
  stmts.push({
    sql: 'INSERT OR IGNORE INTO _hlc (id, wall, counter, device_id) VALUES (1, ?, 0, ?)',
    args: [nowMs, deviceId],
  });

  const present: Record<string, boolean> = {};
  for (const t of Object.keys(SYNC_TABLES)) present[t] = await tableExists(client, t);

  for (const tbl of ['tags', 'category_rules', 'name_rules']) {
    if (!present[tbl]) continue;
    if (!(await hasColumn(client, tbl, 'uuid'))) stmts.push(`ALTER TABLE ${tbl} ADD COLUMN uuid TEXT`);
    stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${tbl}_uuid ON ${tbl}(uuid)`);
  }
  for (const t of Object.values(SYNC_TABLES)) {
    if (!present[t.tbl]) continue;
    for (const s of triggersFor(t)) {
      stmts.push(s.replace('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER IF NOT EXISTS'));
    }
  }

  const ops = await collectBackfill(client);
  // The clock row does not exist yet in `client` (the migration is not run), so
  // tick from the value we are about to insert.
  let st: HlcState = { wall: nowMs, counter: 0 };
  for (const op of ops) {
    st = tickHlc(st, nowMs);
    stmts.push({
      sql: `INSERT INTO _oplog (op_id, tbl, pk, kind, fields, hlc, device_id, origin) VALUES (?, ?, ?, 'upsert', ?, ?, ?, 'backfill')`,
      args: [
        globalThis.crypto.randomUUID().replace(/-/g, ''), op.tbl, JSON.stringify(op.pk),
        JSON.stringify(op.fields ?? {}), formatHlc(st.wall, st.counter, deviceId), deviceId,
      ],
    });
  }
  stmts.push({
    sql: 'UPDATE _hlc SET wall = MAX(wall, ?), counter = CASE WHEN wall >= ? THEN MAX(counter, ?) ELSE counter END WHERE id = 1',
    args: [st.wall, st.wall, st.counter],
  });
  return stmts;
}

export async function oplogInstalled(client: Pick<Client, 'execute'>): Promise<boolean> {
  return tableExists(client, '_oplog');
}

// ── Client-owned rows (migration 3) ──────────────────────────────────────────
//
// CSV/manual accounts, manual transactions and manual balances sync as
// client-owned rows. Installed by the hosted-mode enable migration only (a BYOK
// database never gets the columns or triggers). Local pk shapes:
//
//   accounts         {"id": <local id>, "wire": <acct-uuid or null until derived>}
//   balance_history  {"account_id": <local id>, "wire": <wire id or null>, "date"}
//   transactions     {"id"}; client DELETEs also carry "account_id" (cascade moot)
//
// A transaction's source is immutable and its id prefix says who owns it, so
// plaid-source rows never hit these triggers.

const clientTx = (p: 'NEW' | 'OLD') => `${p}.source IN ('manual', 'csv')`;
const txFieldsJson = `json_object(${CLIENT_TX_FIELDS.map((c) => `${q(c)}, NEW.${c}`).join(', ')})`;
const acctFieldsJson =
  `json_object(${CLIENT_ACCOUNT_FIELDS.map((c) => `${q(c)}, NEW.${c}`).join(', ')}, 'origin', 'client')`;
const acctChanged = (cols: readonly string[]) =>
  `(SELECT json_group_object(k, v) FROM (${cols
    .map((c, i) => `${i ? 'UNION ALL ' : ''}SELECT ${q(c)} AS k, NEW.${c} AS v WHERE OLD.${c} IS NOT NEW.${c}`)
    .join(' ')}))`;
const acctOwnedSql = (idExpr: string) =>
  `EXISTS (SELECT 1 FROM accounts _a WHERE _a.id = ${idExpr} AND ${clientAccountSql('_a')})`;
const wireOf = (idExpr: string) => `(SELECT wire_id FROM accounts WHERE id = ${idExpr})`;

export function clientOwnedTriggers(): string[] {
  const out: string[] = [];
  const off = APPLYING_OFF;
  // accounts
  out.push(trigger('_sync_accounts_ins', 'INSERT ON accounts', `${off} AND ${clientAccountSql('NEW')}`,
    logOp('accounts', 'upsert', `json_object('id', NEW.id, 'wire', NEW.wire_id)`, acctFieldsJson)));
  out.push(trigger('_sync_accounts_upd', `UPDATE OF ${CLIENT_ACCOUNT_FIELDS.join(', ')} ON accounts`,
    `${off} AND ${clientAccountSql('NEW')} AND (${anyChanged([...CLIENT_ACCOUNT_FIELDS])})`,
    logOp('accounts', 'upsert', `json_object('id', NEW.id, 'wire', NEW.wire_id)`, acctChanged(CLIENT_ACCOUNT_FIELDS))));
  out.push(trigger('_sync_accounts_del', 'DELETE ON accounts', `${off} AND ${clientAccountSql('OLD')}`,
    logOp('accounts', 'delete', `json_object('id', OLD.id, 'wire', OLD.wire_id)`, null)));
  // balance_history (rows of client accounts only)
  const bpk = (p: 'NEW' | 'OLD') =>
    `json_object('account_id', ${p}.account_id, 'wire', ${wireOf(`${p}.account_id`)}, 'date', ${p}.date)`;
  out.push(trigger('_sync_balance_history_ins', 'INSERT ON balance_history',
    `${off} AND ${acctOwnedSql('NEW.account_id')}`,
    logOp('balance_history', 'upsert', bpk('NEW'), `json_object('balance', NEW.balance, 'origin', 'client')`)));
  out.push(trigger('_sync_balance_history_upd', 'UPDATE OF balance ON balance_history',
    `${off} AND ${acctOwnedSql('NEW.account_id')} AND OLD.balance IS NOT NEW.balance AND OLD.account_id IS NEW.account_id AND OLD.date IS NEW.date`,
    logOp('balance_history', 'upsert', bpk('NEW'), `json_object('balance', NEW.balance)`)));
  out.push(trigger('_sync_balance_history_del', 'DELETE ON balance_history',
    `${off} AND ${acctOwnedSql('OLD.account_id')}`,
    logOp('balance_history', 'delete', bpk('OLD'), null)));
  // transactions the client owns (manual / csv). Annotation edits are covered
  // by the annotation trigger installed with migration 2.
  out.push(trigger('_sync_transactions_ins', 'INSERT ON transactions', `${off} AND ${clientTx('NEW')}`,
    logOp('transactions', 'upsert', `json_object('id', NEW.id)`, txFieldsJson)));
  out.push(trigger('_sync_transactions_upd_body', `UPDATE OF ${CLIENT_TX_BODY_FIELDS.join(', ')} ON transactions`,
    `${off} AND ${clientTx('NEW')} AND (${anyChanged([...CLIENT_TX_BODY_FIELDS])})`,
    logOp('transactions', 'upsert', `json_object('id', NEW.id)`, changedFields(SYNC_TABLES.transactions, [...CLIENT_TX_BODY_FIELDS]))));
  out.push(trigger('_sync_transactions_del', 'DELETE ON transactions', `${off} AND ${clientTx('OLD')}`,
    logOp('transactions', 'delete', `json_object('id', OLD.id, 'account_id', OLD.account_id)`, null)));
  return out;
}

/**
 * Local client-owned rows as upsert ops, parents first (accounts, then
 * transactions, then balances; transaction_tags ride in collectBackfill).
 * CSV-source rows are not queued: their ids are not derivable yet (P1), they
 * stay local-only and are counted in SyncInfo.localOnlyCount.
 */
export async function collectClientBackfill(client: Pick<Client, 'execute'>): Promise<OpInput[]> {
  const ops: OpInput[] = [];
  if (!(await tableExists(client, 'accounts'))) return ops;
  const hasOrigin = await hasColumn(client, 'accounts', 'origin');
  const hasWire = await hasColumn(client, 'accounts', 'wire_id');
  const plaidish =
    `(item_id IS NOT NULL OR EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id AND COALESCE(t.source, 'plaid') = 'plaid')` +
    ` OR id IN (SELECT value FROM _sync_state WHERE key LIKE 'account_map:%'))`;
  const owned = hasOrigin ? `COALESCE(origin, CASE WHEN ${plaidish} THEN 'plaid' ELSE 'client' END) = 'client'` : `NOT ${plaidish}`;
  const accts = await rowsOf(client, `SELECT *${hasWire ? '' : ', NULL AS wire_id'} FROM accounts WHERE ${owned} ORDER BY rowid`);
  const ids = new Set(accts.map((a) => String(a.id)));
  const add = (tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>) =>
    ops.push({ tbl, pk, kind: 'upsert', fields, origin: 'backfill' });
  for (const a of accts) {
    const f: Record<string, unknown> = { origin: 'client' };
    for (const c of CLIENT_ACCOUNT_FIELDS) f[c] = a[c] ?? null;
    add('accounts', { id: a.id, wire: a.wire_id ?? null }, f);
  }
  if (ids.size > 0 && (await tableExists(client, 'transactions'))) {
    for (const t of await rowsOf(client, `SELECT * FROM transactions WHERE source = 'manual' ORDER BY rowid`)) {
      if (!ids.has(String(t.account_id)) && !(await accountExists(client, String(t.account_id)))) continue;
      const f: Record<string, unknown> = {};
      for (const c of CLIENT_TX_FIELDS) f[c] = t[c] ?? null;
      add('transactions', { id: t.id }, f);
    }
  }
  if (ids.size > 0 && (await tableExists(client, 'balance_history'))) {
    for (const b of await rowsOf(client, 'SELECT account_id, date, balance FROM balance_history ORDER BY account_id, date')) {
      if (!ids.has(String(b.account_id))) continue;
      const a = accts.find((x) => String(x.id) === String(b.account_id));
      add('balance_history', { account_id: b.account_id, wire: a?.wire_id ?? null, date: b.date }, { balance: b.balance, origin: 'client' });
    }
  }
  return ops;
}

async function accountExists(client: Pick<Client, 'execute'>, id: string): Promise<boolean> {
  const r = await client.execute({ sql: 'SELECT item_id FROM accounts WHERE id = ?', args: [id] });
  return r.rows.length > 0;
}

/**
 * Migration 3: additive columns (accounts.origin, accounts.wire_id), the
 * client-owned triggers and the enable-time backfill of existing local client
 * accounts / manual transactions / balances. Hosted mode only.
 */
export async function installClientOwnedStatements(
  client: Pick<Client, 'execute'>,
  nowMs: number = Date.now(),
): Promise<InStatement[]> {
  const stmts: InStatement[] = [];
  if (!(await tableExists(client, 'accounts'))) return stmts;
  if (!(await hasColumn(client, 'accounts', 'origin'))) stmts.push('ALTER TABLE accounts ADD COLUMN origin TEXT');
  if (!(await hasColumn(client, 'accounts', 'wire_id'))) stmts.push('ALTER TABLE accounts ADD COLUMN wire_id TEXT');
  stmts.push('CREATE INDEX IF NOT EXISTS idx_accounts_wire_id ON accounts(wire_id)');
  // Origin backfill: Plaid links (item_id, Plaid-source transactions, adopted
  // accounts) are plaid; everything else was created on this device: client.
  stmts.push(
    `UPDATE accounts SET origin = CASE
        WHEN item_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id AND COALESCE(t.source, 'plaid') = 'plaid')
          OR id IN (SELECT value FROM _sync_state WHERE key LIKE 'account_map:%')
        THEN 'plaid' ELSE 'client' END
      WHERE origin IS NULL`,
  );
  stmts.push(...clientOwnedTriggers());
  const ops = await collectClientBackfill(client);
  stmts.push(...(await queueOpsStatements(client, ops, nowMs)));
  return stmts;
}

// ── Synced imports + CSV rows (migration 4) ──────────────────────────────────
//
//   imports   {"id": <local integer id>, "wire": <uuid or null until derived>}
//
// The wire id is uuidv5(user, file hash, account wire id) and lives in
// imports.wire_id (like accounts.wire_id). transactions.import_id is the local
// integer; it is mapped to the import's uuid at push and back at apply.

export function importsTriggers(): string[] {
  const off = APPLYING_OFF;
  const pk = (p: 'NEW' | 'OLD') => `json_object('id', ${p}.id, 'wire', ${p}.wire_id)`;
  const cols = [...CLIENT_IMPORT_FIELDS];
  const json = `json_object(${cols.map((c) => `${q(c)}, NEW.${c}`).join(', ')})`;
  const changed = `(SELECT json_group_object(k, v) FROM (${cols
    .map((c, i) => `${i ? 'UNION ALL ' : ''}SELECT ${q(c)} AS k, NEW.${c} AS v WHERE OLD.${c} IS NOT NEW.${c}`)
    .join(' ')}))`;
  return [
    trigger('_sync_imports_ins', 'INSERT ON imports', off, logOp('imports', 'upsert', pk('NEW'), json)),
    trigger('_sync_imports_upd', `UPDATE OF ${cols.join(', ')} ON imports`,
      `${off} AND (${anyChanged(cols)})`, logOp('imports', 'upsert', pk('NEW'), changed)),
    trigger('_sync_imports_del', 'DELETE ON imports', off, logOp('imports', 'delete', pk('OLD'), null)),
  ];
}

/** Rows with no op of any state for (tbl, id) yet, as backfill input. */
async function hasOpFor(client: Pick<Client, 'execute'>, tbl: string, id: unknown): Promise<boolean> {
  const r = await client.execute({
    sql: `SELECT 1 FROM _oplog WHERE tbl = ? AND json_extract(pk, '$.id') = ? LIMIT 1`, args: [tbl, String(id)],
  });
  return r.rows.length > 0;
}

/**
 * Upsert ops for local imports and CSV-source transactions (legacy ids; the
 * engine re-keys them to derived ids and patches these ops). Parents first.
 * `skipExisting`: leave out rows that already have an op (migration on top of
 * migration 3 / reset never double-queues).
 */
export async function collectCsvBackfill(
  client: Pick<Client, 'execute'>,
  opts: { skipExisting?: boolean } = {},
): Promise<OpInput[]> {
  const ops: OpInput[] = [];
  if (!(await tableExists(client, 'imports')) || !(await tableExists(client, 'transactions'))) return ops;
  const add = (tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>) =>
    ops.push({ tbl, pk, kind: 'upsert', fields, origin: 'backfill' });
  for (const i of await rowsOf(client, 'SELECT * FROM imports ORDER BY id')) {
    if (opts.skipExisting && (await hasOpFor(client, 'imports', i.id))) continue;
    const f: Record<string, unknown> = {};
    for (const c of CLIENT_IMPORT_FIELDS) f[c] = i[c] ?? null;
    add('imports', { id: i.id, wire: null }, f);
  }
  for (const t of await rowsOf(client, `SELECT * FROM transactions WHERE source = 'csv' ORDER BY rowid`)) {
    if (opts.skipExisting && (await hasOpFor(client, 'transactions', t.id))) continue;
    const f: Record<string, unknown> = {};
    for (const c of CLIENT_TX_FIELDS) f[c] = t[c] ?? null;
    add('transactions', { id: t.id }, f);
  }
  return ops;
}

/** Migration 4: imports.wire_id, import triggers, backfill of imports and CSV rows. */
export async function installImportsStatements(
  client: Pick<Client, 'execute'>,
  nowMs: number = Date.now(),
): Promise<InStatement[]> {
  const stmts: InStatement[] = [];
  if (!(await tableExists(client, 'imports'))) return stmts;
  if (!(await hasColumn(client, 'imports', 'wire_id'))) stmts.push('ALTER TABLE imports ADD COLUMN wire_id TEXT');
  stmts.push('CREATE INDEX IF NOT EXISTS idx_imports_wire_id ON imports(wire_id)');
  stmts.push(...importsTriggers());
  const ops = await collectCsvBackfill(client, { skipExisting: true });
  stmts.push(...(await queueOpsStatements(client, ops, nowMs)));
  return stmts;
}
