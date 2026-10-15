/**
 * In-memory implementation of the sync server's operation-log protocol described in
 * core/SYNC_PROTOCOL.md. Test-only. It models the server rules the client must
 * survive: per-user monotonic server_seq, per-FIELD last-writer-wins by HLC,
 * soft deletes that a newer upsert revives, idempotency by op_id, and the
 * reject reasons (forbidden_table, forbidden_field, invalid_pk, invalid_hlc,
 * stale, row_missing, conflict_unique, forbidden_owner, invalid_source,
 * invalid_amount), plus 402 and 410 (compaction).
 *
 * Client-owned rows (see core/SYNC_PROTOCOL.md "Ownership"): accounts with
 * origin 'client' (`acct-` ids), transactions with source csv|manual
 * (`csv-`/`manual-` ids) and balance_history keyed {account_id, date}. Deletes
 * are soft; deleting a client account tombstones its client-owned children and
 * appends one delete op per child with device_id null.
 */

export type ServerOp = {
  server_seq: number;
  op_id: string;
  device_id: string | null;
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
  accounts: { pk: ['id'], fields: [] },
  balance_history: { pk: ['account_id', 'date'], fields: ['balance'] },
};
const PLAID_TX_ANNOTATIONS = ['manual_category', 'display_name', 'ignored'];
const CLIENT_ACCOUNT_FIELDS = [
  'name', 'type', 'subtype', 'institution_name', 'mask', 'nickname', 'owner', 'apr', 'excluded', 'origin', 'merged_into',
];
const CLIENT_TX_FIELDS = [
  'account_id', 'date', 'name', 'merchant_name', 'amount', 'raw_category', 'source', 'import_id', 'dedup_key',
  'original_date', 'manual_category', 'display_name', 'ignored', 'absorbs',
];
const badAmount = (v: unknown): boolean => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12;
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
  /** Raw POST batches, for volume / ordering assertions. */
  batches: { device_id: string; ops: { op_id: string; tbl: string; kind: string }[] }[] = [];
}

export const rowKey = (tbl: string, pk: Record<string, unknown>): string =>
  `${tbl}|${CO_OWNED[tbl]?.pk.map((k) => String(pk[k])).join('|') ?? JSON.stringify(pk)}`;

export class FakeServer {
  users = new Map<string, UserState>();
  /** user ids that get HTTP 402 */
  unpaid = new Set<string>();
  /** Make the next N POST /sync/ops fail with 500. */
  failPosts = 0;
  /** After this many further successful POST /sync/ops, answer 500 until reset (kill-mid-push simulation). */
  postBudget: number | null = null;
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

  /** A Plaid-owned balance point (pk {account_id, date}; snapshot rows still carry an id). */
  putBalance(userId: string, b: { account_id: string; date: string; balance: number }): void {
    const u = this.user(userId);
    u.plaid.balance_history.set(`${b.account_id}|${b.date}`, { id: u.plaid.balance_history.size + 1, ...b });
    this.serverOp(userId, 'balance_history', { account_id: b.account_id, date: b.date }, { balance: b.balance });
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
      if (this.postBudget !== null) {
        if (this.postBudget <= 0) return json(500, { error: 'killed' });
        this.postBudget--;
      }
      const body = JSON.parse(String(init.body)) as { device_id: string; ops: Omit<ServerOp, 'server_seq' | 'device_id'>[] };
      if (body.ops.length > 500) return json(400, { error: 'too_many_ops' });
      u.batches.push({ device_id: body.device_id, ops: body.ops.map((o) => ({ op_id: o.op_id, tbl: o.tbl, kind: o.kind })) });
      // Rank order, like the real server: accounts/tags, then imports/co-owned,
      // then transactions/balances, then transaction_tags; stable within a rank.
      const rank = (t: string) => (t === 'accounts' || t === 'tags' ? 0 : t === 'transactions' || t === 'balance_history' ? 2
        : t === 'transaction_tags' ? 3 : 1);
      body.ops = body.ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o.tbl) - rank(b.o.tbl) || a.i - b.i).map((x) => x.o);
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
      if (tbl === 'transactions' || tbl === 'accounts' || tbl === 'balance_history') continue;
      const rows: Record<string, unknown>[] = [];
      for (const [k, r] of u.rows) {
        if (!k.startsWith(`${tbl}|`) || !r.exists) continue;
        rows.push({ ...r.pk, ...Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) });
      }
      tables[tbl] = { rows, deletes: [] };
    }
    const clientRows = (tbl: string, pred: (k: string, r: RowState) => boolean) => {
      const out: Record<string, unknown>[] = [];
      for (const [k, r] of u.rows) {
        if (!k.startsWith(`${tbl}|`) || !r.exists || !pred(k, r)) continue;
        out.push({ ...r.pk, ...Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) });
      }
      return out;
    };
    tables.accounts = { rows: [...u.plaid.accounts.values(), ...clientRows('accounts', () => true)], deletes: [] };
    tables.transactions = {
      rows: [...u.plaid.transactions.values()].map((t) => {
        const r = u.rows.get(rowKey('transactions', { id: String(t.id) }));
        const ann = r ? Object.fromEntries(Object.entries(r.fields).map(([f, s]) => [f, s.v])) : {};
        return { ...t, ...ann };
      }),
      deletes: [],
    };
    tables.transactions.rows.push(...clientRows('transactions', (_k, r) => /^(manual|csv)-/.test(String(r.pk.id))));
    let bid = 1_000_000;
    tables.balance_history = {
      rows: [...u.plaid.balance_history.values(), ...clientRows('balance_history', () => true).map((r) => ({ id: bid++, ...r }))],
      deletes: [],
    };
    return { cursor: 'x', server_seq: u.seq, tables };
  }

  /** Apply an op as if another device had pushed it. Returns 'accepted' or the reject reason. */
  inject(userId: string, deviceId: string, op: Omit<ServerOp, 'server_seq' | 'device_id'>): string {
    return this.apply(this.user(userId), deviceId, op);
  }

  /** Client-origin write to a transactions row the client may own (csv-/manual-)? */
  private isClientWrite(u: UserState, op: { tbl: string; pk: Record<string, unknown> }, fields: Record<string, unknown>): boolean {
    if (op.tbl === 'accounts' || op.tbl === 'balance_history') return true;
    if (op.tbl !== 'transactions') return false;
    const id = String(op.pk.id);
    return !u.plaid.transactions.has(id) && (/^(manual|csv)-/.test(id) || 'source' in fields);
  }

  private liveClientAccount(u: UserState, id: string): boolean {
    return u.rows.get(rowKey('accounts', { id }))?.exists === true;
  }

  /** Ownership / source / amount validation for client-owned rows. Returns a reject reason or null. */
  private checkOwnership(u: UserState, op: Omit<ServerOp, 'server_seq' | 'device_id'>, fields: Record<string, unknown>): string | null {
    const live = (tbl: string) => u.rows.get(rowKey(tbl, op.pk))?.exists === true;
    if (op.tbl === 'accounts') {
      const id = String(op.pk.id);
      if (u.plaid.accounts.has(id)) return 'forbidden_owner';
      if (!id.startsWith('acct-')) return 'invalid_pk';
      for (const f of Object.keys(fields)) if (!CLIENT_ACCOUNT_FIELDS.includes(f)) return 'forbidden_field';
      if (op.kind === 'upsert') {
        const cur = u.rows.get(rowKey('accounts', op.pk));
        const hadRow = cur != null && cur.fields.origin != null;
        const o = fields.origin;
        if (o === 'plaid') return 'forbidden_owner';
        if (o !== undefined && o !== 'client') return 'invalid_source';
        if (!hadRow && o === undefined) return 'invalid_source';
      }
      return null;
    }
    if (op.tbl === 'balance_history') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(op.pk.date))) return 'invalid_pk';
      const acct = String(op.pk.account_id);
      if (u.plaid.accounts.has(acct)) return 'forbidden_owner';
      if (op.kind === 'upsert') {
        for (const f of Object.keys(fields)) if (f !== 'balance') return 'forbidden_field';
        if ('balance' in fields && badAmount(fields.balance)) return 'invalid_amount';
      }
      if (!this.liveClientAccount(u, acct)) return op.kind === 'delete' ? null : 'row_missing';
      return null;
    }
    if (op.tbl === 'transactions') {
      const id = String(op.pk.id);
      if (u.plaid.transactions.has(id)) {
        if ('source' in fields) return 'forbidden_owner';
        return null; // annotation allowlist enforced by the caller
      }
      const prefixed = /^(manual|csv)-/.test(id);
      if (!prefixed) {
        // Unprefixed id, not a Plaid row we know: a client may not create it.
        if ('source' in fields) return 'invalid_pk';
        return null; // annotation on a row not synced yet: row_missing (caller)
      }
      if (op.kind === 'delete') return null;
      for (const f of Object.keys(fields)) if (!CLIENT_TX_FIELDS.includes(f)) return 'forbidden_field';
      const cur = u.rows.get(rowKey('transactions', op.pk));
      const exists = cur?.exists === true;
      const src = fields.source;
      if (!exists && !(cur && cur.fields.source)) {
        if (src === undefined) return 'invalid_source';
        if (src === 'plaid') return 'forbidden_owner';
        if (src !== 'csv' && src !== 'manual') return 'invalid_source';
        if (!id.startsWith(`${src}-`)) return 'invalid_source';
      } else if (src !== undefined && src !== cur!.fields.source?.v) return 'invalid_source';
      if ('amount' in fields && badAmount(fields.amount)) return 'invalid_amount';
      const acct = fields.account_id ?? cur?.fields.account_id?.v;
      if (acct == null) return 'invalid_pk';
      if ('account_id' in fields || !exists) {
        if (!u.plaid.accounts.has(String(acct)) && !this.liveClientAccount(u, String(acct))) return 'row_missing';
      }
      const dk = fields.dedup_key ?? cur?.fields.dedup_key?.v;
      if (dk != null) {
        for (const [k, r] of u.rows) {
          if (!k.startsWith('transactions|') || !r.exists || k === rowKey('transactions', op.pk)) continue;
          if (r.fields.account_id?.v === acct && r.fields.dedup_key?.v === dk) return 'conflict_unique';
        }
      }
      void live;
    }
    return null;
  }

  private cascadeAccount(u: UserState, accountId: string, hlc: string): void {
    for (const [k, r] of u.rows) {
      const child =
        (k.startsWith('transactions|') && r.fields.account_id?.v === accountId && /^(manual|csv)-/.test(String(r.pk.id))) ||
        (k.startsWith('balance_history|') && r.pk.account_id === accountId);
      if (!child || !r.exists) continue;
      r.exists = false;
      r.deletedHlc = hlc;
      u.seq++;
      u.ops.push({
        server_seq: u.seq, op_id: `srv-cascade-${u.seq}`, device_id: null,
        tbl: k.slice(0, k.indexOf('|')), pk: r.pk, kind: 'delete', fields: null, hlc,
      });
    }
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
    const own = this.checkOwnership(u, op, fields);
    if (own) return own;
    if (!this.isClientWrite(u, op, fields)) {
      for (const f of Object.keys(fields)) {
        if (!spec.fields.includes(f)) {
          return op.tbl === 'transactions' && u.plaid.transactions.has(String(op.pk.id)) ? 'forbidden_owner' : 'forbidden_field';
        }
      }
    }
    if (op.tbl === 'settings' && !SETTINGS_ALLOW.includes(String(op.pk.key))) return 'forbidden_field';

    const key = rowKey(op.tbl, op.pk);
    let row = u.rows.get(key);
    if (op.tbl === 'transactions' && (!row || !row.exists) && !this.isClientWrite(u, op, fields)) return 'row_missing';
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
      if (op.tbl === 'accounts') this.cascadeAccount(u, String(op.pk.id), op.hlc);
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
