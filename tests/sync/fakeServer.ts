/**
 * In-memory implementation of the sync server's operation-log protocol described in
 * core/SYNC_PROTOCOL.md. Test-only. It models the server rules the client must
 * survive: per-user monotonic server_seq, per-FIELD last-writer-wins by HLC,
 * soft deletes that a newer upsert revives, idempotency by op_id, and the
 * reject reasons (forbidden_table, forbidden_field, invalid_pk, invalid_hlc,
 * stale, row_missing, conflict_unique), plus 402 and 410 (compaction).
 */

export type ServerOp = {
  server_seq: number;
  op_id: string;
  device_id: string;
  tbl: string;
  pk: Record<string, unknown>;
  kind: 'upsert' | 'delete' | 'server_upsert';
  fields: Record<string, unknown> | null;
  hlc: string;
};

type RowState = {
  fields: Record<string, { v: unknown; hlc: string }>;
  exists: boolean;
  deletedHlc: string | null;
  pk: Record<string, unknown>;
};

const CO_OWNED: Record<string, { pk: string[]; fields: string[] }> = {
  categories: { pk: ['name'], fields: ['flexibility'] },
  hidden_categories: { pk: ['category'], fields: [] },
  settings: { pk: ['key'], fields: ['value'] },
  household_members: { pk: ['id'], fields: ['name', 'birth_year', 'sort_order'] },
  tags: { pk: ['id'], fields: ['name'] },
  category_rules: { pk: ['id'], fields: ['priority', 'match_type', 'pattern', 'category', 'min_amount', 'max_amount'] },
  name_rules: { pk: ['id'], fields: ['match_type', 'pattern', 'replacement', 'min_amount', 'max_amount'] },
  transaction_tags: { pk: ['transaction_id', 'tag_id'], fields: [] },
  transactions: { pk: ['id'], fields: ['manual_category', 'display_name', 'ignored'] },
};
const SETTINGS_ALLOW = ['plaid_default_start_date', 'pretax_monthly'];
const MAX_FUTURE_MS = 5 * 60_000;

class UserState {
  seq = 0;
  minSeq = 0;
  ops: ServerOp[] = [];
  seen = new Map<string, 'accepted' | 'stale'>();
  rows = new Map<string, RowState>();
  plaid = {
    accounts: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    balance_history: new Map<string, Record<string, unknown>>(),
  };
}

export const rowKey = (tbl: string, pk: Record<string, unknown>): string =>
  `${tbl}|${CO_OWNED[tbl]?.pk.map((k) => String(pk[k])).join('|') ?? JSON.stringify(pk)}`;

export class FakeServer {
  users = new Map<string, UserState>();
  /** user ids that get HTTP 402 */
  unpaid = new Set<string>();
  /** Make the next N POST /sync/ops fail with 500. */
  failPosts = 0;
  /** Fail GET /sync/ops after serving this many pages (crash simulation hook). */
  now = () => Date.now();
  /** When false, POST /sync/ops answers 404 (server side not deployed). */
  opsEnabled = true;
  requests: { method: string; path: string }[] = [];

  user(id: string): UserState {
    let u = this.users.get(id);
    if (!u) { u = new UserState(); this.users.set(id, u); }
    return u;
  }

  /** Raw op count for a user's log (any kind). */
  opsOf(userId: string): ServerOp[] { return this.user(userId).ops; }

  /** Current materialised state of a co-owned row, or null if absent/deleted. */
  row(userId: string, tbl: string, pk: Record<string, unknown>): Record<string, unknown> | null {
    const r = this.user(userId).rows.get(rowKey(tbl, pk));
    if (!r || !r.exists) return null;
    return Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.v]));
  }

  liveRows(userId: string, tbl: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const [k, r] of this.user(userId).rows) {
      if (k.startsWith(`${tbl}|`) && r.exists) out.push({ ...r.pk, ...Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) });
    }
    return out;
  }

  // ── Plaid-owned data (what the server's Plaid sync would write) ──────────

  private serverOp(userId: string, tbl: string, pk: Record<string, unknown>, fields: Record<string, unknown>): void {
    const u = this.user(userId);
    u.seq++;
    u.ops.push({
      server_seq: u.seq, op_id: `srv-${u.seq}`, device_id: 'server', tbl, pk,
      kind: 'server_upsert', fields, hlc: '',
    });
  }

  putAccount(userId: string, a: { id: string; name: string; type: string; subtype?: string | null; institution_name?: string | null; mask?: string | null }): void {
    this.user(userId).plaid.accounts.set(a.id, a);
    this.serverOp(userId, 'accounts', { id: a.id }, { ...a });
  }

  putTransaction(userId: string, t: { id: string; account_id: string; date: string; name: string; amount: number; category?: string | null; pending?: number }): void {
    const row = { merchant_name: null, category: null, raw_category: null, pending: 0, ...t };
    this.user(userId).plaid.transactions.set(t.id, row);
    this.serverOp(userId, 'transactions', { id: t.id }, row);
    // The transaction row now exists for annotation ops.
    const u = this.user(userId);
    const k = rowKey('transactions', { id: t.id });
    if (!u.rows.has(k)) u.rows.set(k, { fields: {}, exists: true, deletedHlc: null, pk: { id: t.id } });
  }

  removeTransaction(userId: string, id: string): void {
    this.user(userId).plaid.transactions.delete(id);
    this.serverOp(userId, 'transactions', { id }, { removed: true });
    this.user(userId).rows.delete(rowKey('transactions', { id }));
  }

  /** Discard ops with seq <= n: a client below it must resync. */
  compact(userId: string, n: number): void {
    const u = this.user(userId);
    u.minSeq = n;
    u.ops = u.ops.filter((o) => o.server_seq > n);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    this.requests.push({ method, path: url.pathname });
    const auth = new Headers(init.headers as HeadersInit).get('Authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    let sub: string;
    try { sub = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return json(401, { error: 'unauthorized' }); }
    if (this.unpaid.has(sub)) return json(402, { error: 'payment_required' });
    const u = this.user(sub);

    if (url.pathname === '/sync/pull' && method === 'GET') return json(200, this.snapshot(u));
    if (url.pathname === '/sync/ops' && !this.opsEnabled) return json(404, { error: 'not_found' });
    if (url.pathname === '/sync/ops' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 500);
      if (since < u.minSeq) return json(410, { error: 'resync_required' });
      const rest = u.ops.filter((o) => o.server_seq > since).sort((a, b) => a.server_seq - b.server_seq);
      const page = rest.slice(0, limit);
      return json(200, {
        ops: page,
        next_seq: page.length ? page[page.length - 1].server_seq : since,
        has_more: rest.length > page.length,
      });
    }
    if (url.pathname === '/sync/ops' && method === 'POST') {
      if (this.failPosts > 0) { this.failPosts--; return json(500, { error: 'boom' }); }
      const body = JSON.parse(String(init.body)) as { device_id: string; ops: Omit<ServerOp, 'server_seq' | 'device_id'>[] };
      if (body.ops.length > 500) return json(400, { error: 'too_many_ops' });
      const accepted: string[] = [];
      const rejected: { op_id: string; reason: string }[] = [];
      for (const op of body.ops) {
        const r = this.apply(u, body.device_id, op);
        if (r === 'accepted') accepted.push(op.op_id);
        else rejected.push({ op_id: op.op_id, reason: r });
      }
      return json(200, { accepted, rejected, server_seq: u.seq });
    }
    return json(404, { error: 'not_found' });
  };

  private snapshot(u: UserState) {
    const tables: Record<string, { rows: Record<string, unknown>[]; deletes: unknown[] }> = {};
    for (const tbl of Object.keys(CO_OWNED)) {
      if (tbl === 'transactions') continue;
      const rows: Record<string, unknown>[] = [];
      for (const [k, r] of u.rows) {
        if (!k.startsWith(`${tbl}|`) || !r.exists) continue;
        rows.push({ ...r.pk, ...Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) });
      }
      tables[tbl] = { rows, deletes: [] };
    }
    tables.accounts = { rows: [...u.plaid.accounts.values()], deletes: [] };
    tables.transactions = {
      rows: [...u.plaid.transactions.values()].map((t) => {
        const r = u.rows.get(rowKey('transactions', { id: String(t.id) }));
        const ann = r ? Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) : {};
        return { ...t, ...ann };
      }),
      deletes: [],
    };
    tables.balance_history = { rows: [...u.plaid.balance_history.values()], deletes: [] };
    return { cursor: 'x', server_seq: u.seq, tables };
  }

  /** Apply an op as if another device had pushed it. Returns 'accepted' or the reject reason. */
  inject(userId: string, deviceId: string, op: Omit<ServerOp, 'server_seq' | 'device_id'>): string {
    return this.apply(this.user(userId), deviceId, op);
  }

  private apply(u: UserState, deviceId: string, op: Omit<ServerOp, 'server_seq' | 'device_id'>): string {
    if (u.seen.has(op.op_id)) return u.seen.get(op.op_id) === 'accepted' ? 'accepted' : 'stale';
    const spec = CO_OWNED[op.tbl];
    if (!spec) return 'forbidden_table';
    if (!spec.pk.every((k) => typeof op.pk?.[k] === 'string' && String(op.pk[k]) !== '')) return 'invalid_pk';
    const hm = /^(\d{15})-(\d{5})-(.+)$/.exec(op.hlc ?? '');
    if (!hm) return 'invalid_hlc';
    if (Number(hm[1]) > this.now() + MAX_FUTURE_MS) return 'invalid_hlc';
    const fields = op.fields ?? {};
    for (const f of Object.keys(fields)) if (!spec.fields.includes(f)) return 'forbidden_field';
    if (op.tbl === 'settings' && !SETTINGS_ALLOW.includes(String(op.pk.key))) return 'forbidden_field';

    const key = rowKey(op.tbl, op.pk);
    let row = u.rows.get(key);
    if (op.tbl === 'transactions' && (!row || !row.exists)) return 'row_missing';
    if (op.tbl === 'transaction_tags' && op.kind === 'upsert') {
      const tag = u.rows.get(rowKey('tags', { id: op.pk.tag_id }));
      if (!tag || !tag.exists) return 'row_missing';
    }
    // Natural-key uniqueness among live rows.
    if (op.kind === 'upsert' && (op.tbl === 'tags' || op.tbl === 'category_rules' || op.tbl === 'name_rules')) {
      const natural = op.tbl === 'tags' ? ['name'] : ['match_type', 'pattern'];
      const merged = { ...(row ? Object.fromEntries(Object.entries(row.fields).map(([f, s]) => [f, s.v])) : {}), ...fields };
      if (natural.every((n) => n in merged)) {
        for (const [k, r] of u.rows) {
          if (!k.startsWith(`${op.tbl}|`) || !r.exists || k === key) continue;
          if (natural.every((n) => r.fields[n]?.v === merged[n])) return 'conflict_unique';
        }
      }
    }

    u.seq++;
    const logged: ServerOp = { server_seq: u.seq, op_id: op.op_id, device_id: deviceId, tbl: op.tbl, pk: op.pk, kind: op.kind, fields: op.fields ?? null, hlc: op.hlc };
    if (!row) { row = { fields: {}, exists: false, deletedHlc: null, pk: op.pk }; u.rows.set(key, row); }

    if (op.kind === 'delete') {
      const newest = [row.deletedHlc ?? '', ...Object.values(row.fields).map((f) => f.hlc)].sort().pop() ?? '';
      if (!row.exists || op.hlc <= newest) { u.ops.push(logged); u.seen.set(op.op_id, 'stale'); return 'stale'; }
      row.exists = false; row.deletedHlc = op.hlc;
      u.ops.push(logged); u.seen.set(op.op_id, 'accepted');
      return 'accepted';
    }

    // upsert: per-field LWW; row-level hlc only for existence
    if (row.deletedHlc != null && op.hlc <= row.deletedHlc) { u.ops.push(logged); u.seen.set(op.op_id, 'stale'); return 'stale'; }
    let won = 0;
    for (const [f, v] of Object.entries(fields)) {
      const cur = row.fields[f];
      if (!cur || op.hlc > cur.hlc) { row.fields[f] = { v, hlc: op.hlc }; won++; }
    }
    const revived = !row.exists;
    row.exists = true;
    row.deletedHlc = row.deletedHlc != null && op.hlc > row.deletedHlc ? null : row.deletedHlc;
    if (Object.keys(fields).length > 0 && won === 0 && !revived) {
      u.ops.push(logged); u.seen.set(op.op_id, 'stale');
      return 'stale';
    }
    u.ops.push(logged); u.seen.set(op.op_id, 'accepted');
    return 'accepted';
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Unsigned JWT-shaped token: the engine only reads `sub` and `exp`. */
export function fakeJwt(sub: string, email = `${sub}@example.test`): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64({ sub, email, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}
