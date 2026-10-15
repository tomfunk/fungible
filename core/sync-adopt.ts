import type { Client } from '@libsql/client';
import { queueOpsStatements, type OpInput } from './sync-oplog.js';

// Adoption of pre-existing (BYOK-era) local data when the sync server's first pulls
// arrive. The server holds its own Plaid links, so its account and transaction
// ids differ from the ones this install minted. Left alone, a pull would insert
// every server row beside its local twin.
//
// Runs as a pre-pass inside pullSince, in hosted mode only, before the
// pulled rows are applied:
//
//   accounts      local Plaid-linked account <-> pulled server account, by
//                 institution + mask + type (then institution + name + type
//                 when a mask is missing). Matched local accounts are re-keyed
//                 to the server id (children follow); server columns win, local
//                 columns (nickname, owner, apr, excluded, item_id) are kept.
//                 An unmatched local account stays local-only.
//   transactions  within a matched account, never-synced local 'plaid' rows
//                 <-> pulled server rows: same amount, posting date within 3
//                 days, name evidence >= "contains". Greedy ONE-TO-ONE pairing
//                 (best name, then nearest date, then insertion order) so two
//                 real $5 coffees stay two rows. A matched local row is
//                 re-keyed to the server id; server columns win; local
//                 annotations (manual_category, ignored) and tag links move
//                 with it and are queued as ops against the server id (unless
//                 the server row already carries annotations).
//   unmatched     local transactions stay local-only: never pushed (held), keep their
//                 annotations, and are retried whenever new server rows arrive.
//
// Idempotent: matched rows no longer look "never synced", mapped accounts are
// recorded in `_sync_state` as account_map:<localId>, and a second pass over
// the same data changes nothing.
//
// Known limit: the server's transaction rows carry no pending_transaction_id or
// original description, so matching rests on account/amount/date/name only.

const APPLYING_ON = `INSERT INTO _sync_state (key, value) VALUES ('applying', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`;
const APPLYING_OFF = `DELETE FROM _sync_state WHERE key = 'applying'`;

type Row = Record<string, unknown>;
type Arg = string | number | null;

export type AdoptStats = { accounts: number; transactions: number; merged: number };

let _beforeAdopt: (() => Promise<void>) | null = null;

/** Called once, before the first pass that rewrites local ids (take a snapshot here; throw to abort). */
export function setBeforeAdoptHook(fn: (() => Promise<void>) | null): void {
  _beforeAdopt = fn;
}

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const DAY_MS = 86_400_000;
const dayGap = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / DAY_MS;

function nameRank(a: string, b: string): number {
  if (a === b) return 0;
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na && nb && (na.includes(nb) || nb.includes(na))) return 2;
  // Same leading merchant word ("whole foods #123" vs "whole foods market"):
  // amount and date already agree, so a shared 4+ letter first word suffices.
  const fa = na.split(' ')[0];
  if (fa.length >= 4 && fa === nb.split(' ')[0]) return 2;
  return 3;
}

async function rows(c: Client, sql: string, args: Arg[] = []): Promise<Row[]> {
  return (await c.execute({ sql, args })).rows as unknown as Row[];
}

async function getState(c: Client, key: string): Promise<string | null> {
  const r = await rows(c, 'SELECT value FROM _sync_state WHERE key = ?', [key]);
  return r.length ? String(r[0].value) : null;
}
async function setState(c: Client, key: string, value: string): Promise<void> {
  await c.execute({
    sql: 'INSERT INTO _sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value],
  });
}

async function ensureBackup(c: Client): Promise<void> {
  if (await getState(c, 'adopt_backup_done')) return;
  if (_beforeAdopt) await _beforeAdopt();
  else {
    // Default (Node): a snapshot, and fail closed -- a throw aborts adoption
    // before any id is rewritten. The browser build registers its own hook.
    const mod = await import('./snapshot.js');
    await mod.snapshot('pre-adopt-sync', { client: c });
  }
  await setState(c, 'adopt_backup_done', '1');
}

const key = (inst: unknown, mask: unknown, type: unknown) => `${norm(inst)}|${String(mask ?? '').trim()}|${norm(type)}`;

type Match = { local: string; server: string; serverRow: Row; merge: boolean };

// Pairs local and server accounts tier by tier; a pairing is accepted only when
// its key is unique on both sides among the still-unmatched.
function matchAccounts(locals: Row[], servers: { row: Row; merge: boolean }[]): Match[] {
  const out: Match[] = [];
  const L = [...locals];
  const S = [...servers];
  const tiers: Array<(r: Row) => string | null> = [
    (r) => (norm(r.institution_name) && String(r.mask ?? '').trim() ? key(r.institution_name, r.mask, r.type) : null),
    (r) => (norm(r.institution_name) && norm(r.name) ? `${norm(r.institution_name)}|${norm(r.name)}|${norm(r.type)}` : null),
  ];
  for (const k of tiers) {
    const lk = new Map<string, Row[]>();
    const sk = new Map<string, { row: Row; merge: boolean }[]>();
    for (const l of L) { const x = k(l); if (x) lk.set(x, [...(lk.get(x) ?? []), l]); }
    for (const s of S) { const x = k(s.row); if (x) sk.set(x, [...(sk.get(x) ?? []), s]); }
    for (const [x, ls] of lk) {
      const ss = sk.get(x);
      if (ls.length === 1 && ss && ss.length === 1) {
        out.push({ local: String(ls[0].id), server: String(ss[0].row.id), serverRow: ss[0].row, merge: ss[0].merge });
        L.splice(L.indexOf(ls[0]), 1);
        S.splice(S.indexOf(ss[0]), 1);
      }
    }
  }
  return out;
}

export async function adoptByokData(
  c: Client,
  pulled: { accounts?: Row[]; transactions?: Row[] },
): Promise<AdoptStats> {
  const stats: AdoptStats = { accounts: 0, transactions: 0, merged: 0 };
  const serverAccounts = pulled.accounts ?? [];
  const serverTx = (pulled.transactions ?? []).filter((t) => !t.removed);
  if (serverAccounts.length === 0 && serverTx.length === 0) return stats;

  const localAccounts = await rows(c, 'SELECT * FROM accounts');
  const localIds = new Set(localAccounts.map((a) => String(a.id)));
  const mapped = new Set((await rows(c, `SELECT value FROM _sync_state WHERE key LIKE 'account_map:%'`)).map((r) => String(r.value)));
  const pulledAccountIds = new Set(serverAccounts.map((a) => String(a.id)));

  // ── Accounts ────────────────────────────────────────────────────────────
  {
    // Plaid-linked, not already a server account, not the target of an earlier match.
    const plaidish = new Set((await rows(c, `SELECT DISTINCT account_id FROM transactions WHERE COALESCE(source, 'plaid') = 'plaid'`)).map((r) => String(r.account_id)));
    const candLocal = localAccounts.filter((a) => {
      const id = String(a.id);
      return !pulledAccountIds.has(id) && !mapped.has(id) && (a.item_id != null || plaidish.has(id));
    });
    // Server side: pulled accounts we do not hold yet, plus accounts already
    // adopted (a BYOK refresh re-created the old local account -> merge).
    const candServer: { row: Row; merge: boolean }[] = [
      ...serverAccounts.filter((a) => !localIds.has(String(a.id))).map((row) => ({ row, merge: false })),
      ...localAccounts.filter((a) => mapped.has(String(a.id))).map((row) => ({ row, merge: true })),
    ];
    const matches = matchAccounts(candLocal, candServer);
    if (matches.length > 0) await ensureBackup(c);
    for (const m of matches) {
      const stmts: { sql: string; args: Arg[] }[] = [{ sql: 'PRAGMA defer_foreign_keys = ON', args: [] }, { sql: APPLYING_ON, args: [] }];
      const A = (sql: string, ...args: Arg[]) => stmts.push({ sql, args });
      if (m.merge) {
        A('UPDATE transactions SET account_id = ? WHERE account_id = ?', m.server, m.local);
        A('UPDATE OR IGNORE balance_history SET account_id = ? WHERE account_id = ?', m.server, m.local);
        A('DELETE FROM balance_history WHERE account_id = ?', m.local);
        A('DELETE FROM sync_state WHERE account_id = ?', m.local);
        A('DELETE FROM accounts WHERE id = ?', m.local);
        stats.merged++;
      } else {
        const s = m.serverRow;
        A(
          'UPDATE accounts SET id = ?, name = ?, type = ?, subtype = ?, institution_name = ?, mask = ? WHERE id = ?',
          m.server, s.name == null ? null : String(s.name), s.type == null ? null : String(s.type),
          s.subtype == null ? null : String(s.subtype), s.institution_name == null ? null : String(s.institution_name),
          s.mask == null ? null : String(s.mask), m.local,
        );
        A('UPDATE transactions SET account_id = ? WHERE account_id = ?', m.server, m.local);
        A('UPDATE balance_history SET account_id = ? WHERE account_id = ?', m.server, m.local);
        A('DELETE FROM sync_state WHERE account_id = ?', m.local);
        stats.accounts++;
      }
      A('UPDATE category_rules SET account_id = ? WHERE account_id = ?', m.server, m.local);
      A('UPDATE name_rules SET account_id = ? WHERE account_id = ?', m.server, m.local);
      A('UPDATE tag_rules SET account_id = ? WHERE account_id = ?', m.server, m.local);
      A(APPLYING_OFF);
      await c.batch(stmts, 'write');
      await setState(c, `account_map:${m.local}`, m.server);
    }
  }

  // ── Transactions ────────────────────────────────────────────────────────
  if (serverTx.length > 0) {
    const holdAccounts = new Set((await rows(c, 'SELECT id FROM accounts')).map((r) => String(r.id)));
    const serverIds = new Set(serverTx.map((t) => String(t.id)));
    const byAccount = new Map<string, Row[]>();
    for (const t of serverTx) {
      const a = String(t.account_id);
      if (holdAccounts.has(a)) byAccount.set(a, [...(byAccount.get(a) ?? []), t]);
    }
    for (const [accountId, sRows] of byAccount) {
      const locals = (await rows(
        c,
        `SELECT id, date, original_date, name, amount, manual_category, ignored, rowid AS rid
           FROM transactions
          WHERE account_id = ? AND COALESCE(source, 'plaid') = 'plaid' AND id NOT IN (SELECT id FROM _sync_server_tx)
          ORDER BY rowid`,
        [accountId],
      )).filter((l) => !serverIds.has(String(l.id)));
      if (locals.length === 0) continue;
      // Server rows we already hold are not candidates.
      const held = new Set((await rows(c, 'SELECT id FROM transactions WHERE account_id = ?', [accountId])).map((r) => String(r.id)));
      const sCand = sRows.filter((s) => !held.has(String(s.id)));

      type Cand = { li: number; si: number; rank: number; gap: number };
      const cands: Cand[] = [];
      locals.forEach((l, li) => {
        const lDate = String(l.original_date ?? l.date);
        sCand.forEach((s, si) => {
          if (Math.abs(Number(l.amount) - Number(s.amount)) > 0.005) return;
          const gap = dayGap(lDate, String(s.date));
          if (gap > 3) return;
          const rank = nameRank(String(l.name), String(s.name));
          if (rank > 2) return;
          cands.push({ li, si, rank, gap });
        });
      });
      cands.sort((a, b) => a.rank - b.rank || a.gap - b.gap || a.li - b.li || a.si - b.si);
      const usedL = new Set<number>();
      const usedS = new Set<number>();
      const pairs: Cand[] = [];
      for (const p of cands) {
        if (usedL.has(p.li) || usedS.has(p.si)) continue;
        usedL.add(p.li); usedS.add(p.si); pairs.push(p);
      }
      if (pairs.length === 0) continue;
      await ensureBackup(c);

      for (const p of pairs) {
        const l = locals[p.li];
        const s = sCand[p.si];
        const serverAnnotated = s.manual_category != null || Number(s.ignored ?? 0) === 1;
        const oldId = String(l.id);
        const newId = String(s.id);
        const sv = (v: unknown): Arg => (v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Arg));
        // The re-key and every column it touches run under the applying flag:
        // adoption is bookkeeping, not a user edit, so the triggers stay quiet.
        // Annotations worth keeping are queued below as explicit ops.
        const stmts: { sql: string; args: Arg[] }[] = [
          { sql: 'PRAGMA defer_foreign_keys = ON', args: [] },
          { sql: APPLYING_ON, args: [] },
        ];
        const annotation = serverAnnotated
          ? { sql: ', manual_category = ?, display_name = ?, ignored = ?', args: [sv(s.manual_category), sv(s.display_name), sv(s.ignored ?? 0)] as Arg[] }
          : { sql: '', args: [] as Arg[] };
        stmts.push({
          sql: `UPDATE transactions SET id = ?, account_id = ?, date = ?, name = ?, merchant_name = ?, amount = ?,
                  category = ?, raw_category = ?, pending = ?${annotation.sql}
                WHERE id = ?`,
          args: [
            newId, String(s.account_id), String(s.date).slice(0, 10), sv(s.name), sv(s.merchant_name), sv(s.amount),
            sv(s.category), sv(s.raw_category), sv(s.pending), ...annotation.args, oldId,
          ],
        });
        stmts.push({ sql: 'UPDATE transaction_tags SET transaction_id = ? WHERE transaction_id = ?', args: [newId, oldId] });
        stmts.push({ sql: 'UPDATE tag_rule_suppressions SET transaction_id = ? WHERE transaction_id = ?', args: [newId, oldId] });
        stmts.push({ sql: 'INSERT OR IGNORE INTO _sync_server_tx (id) VALUES (?)', args: [newId] });
        // Pending ops addressed to the old id can never be delivered.
        stmts.push({
          sql: `UPDATE _oplog SET pushed = 4, reason = 'adopted'
                WHERE pushed IN (0, 2) AND (
                  (tbl = 'transactions' AND json_extract(pk, '$.id') = ?) OR
                  (tbl = 'transaction_tags' AND json_extract(pk, '$.transaction_id') = ?))`,
          args: [oldId, oldId],
        });
        // Local annotations and tag links follow the row and are sent against the server id.
        const ops: OpInput[] = [];
        const localManual = l.manual_category ?? null;
        const localIgnored = Number(l.ignored ?? 0);
        if (!serverAnnotated && (localManual != null || localIgnored === 1)) {
          const f: Record<string, unknown> = {};
          if (localManual != null) f.manual_category = localManual;
          if (localIgnored === 1) f.ignored = 1;
          ops.push({ tbl: 'transactions', pk: { id: newId }, kind: 'upsert', fields: f });
        }
        for (const link of await rows(c,
          `SELECT tt.tag_id, (SELECT uuid FROM tags WHERE tags.id = tt.tag_id) AS tag_uuid
             FROM transaction_tags tt WHERE tt.transaction_id = ?`, [oldId])) {
          ops.push({
            tbl: 'transaction_tags',
            pk: { transaction_id: newId, tag_id: link.tag_uuid ?? null, tag_lid: link.tag_id },
            kind: 'upsert', fields: {},
          });
        }
        stmts.push(...(await queueOpsStatements(c, ops)) as { sql: string; args: Arg[] }[]);
        stmts.push({ sql: APPLYING_OFF, args: [] });
        await c.batch(stmts, 'write');
        stats.transactions++;
      }
    }
  }
  return stats;
}
