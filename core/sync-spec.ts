// What syncs, and how each table is keyed. Shared by the trigger generator
// (sync-oplog.ts) and the engine (sync-client.ts). Portable: no node:* imports.

// ── Synced settings allowlist ────────────────────────────────────────────────
//
// `settings` is a per-install key/value table, but only some keys are user
// data. An ALLOWLIST (not a denylist) so a newly added per-device key is local
// by default and has to be opted in here deliberately.
//
//   plaid_default_start_date  syncs   user preference about their financial data
//   pretax_monthly            syncs   financial figure the health score uses
//   backup_include_key        LOCAL   per-machine security posture
//   device_id                 LOCAL   this install's identity; never a setting op
//   theme, dials, demo keys   LOCAL   device UI preference / engine bookkeeping
//
// Enforced in the triggers (denied keys never enter the oplog), on push and on
// pull (a denied key from the server is ignored). Keep literals in sync with
// the *_KEY constants in core/settings.ts.
export const SYNCED_SETTINGS_KEYS: readonly string[] = ['plaid_default_start_date', 'pretax_monthly'];
export const isSyncedSetting = (key: string): boolean => SYNCED_SETTINGS_KEYS.includes(key);
export const SYNCED_SETTINGS_SQL_LIST = SYNCED_SETTINGS_KEYS.map((k) => `'${k}'`).join(', ');

// ── Table specs ──────────────────────────────────────────────────────────────

export type SyncKind =
  /** String natural key shared with the server. */
  | 'natural'
  /** Local INTEGER PK; the wire id is a uuid held in the `uuid` column. */
  | 'uuid'
  /** transaction_tags: (transaction_id, tag uuid). */
  | 'link'
  /** Client-writable annotation columns on a server-owned row. */
  | 'annotation'
  /** accounts / transactions / balance_history rows the client owns. */
  | 'client';

export interface SyncTable {
  tbl: string;
  kind: SyncKind;
  /** Local columns forming the key (natural/annotation/link). */
  keyCols: string[];
  /** Synced non-key columns. */
  fields: string[];
  /** uuid kind: columns whose values derive the uuid, and the scoping column. */
  naturalCols?: string[];
  scopedBy?: string;
}

export const SYNC_TABLES: Record<string, SyncTable> = {
  categories:        { tbl: 'categories', kind: 'natural', keyCols: ['name'], fields: ['flexibility'] },
  hidden_categories: { tbl: 'hidden_categories', kind: 'natural', keyCols: ['category'], fields: [] },
  settings:          { tbl: 'settings', kind: 'natural', keyCols: ['key'], fields: ['value'] },
  household_members: { tbl: 'household_members', kind: 'natural', keyCols: ['id'], fields: ['name', 'birth_year', 'sort_order'] },
  tags:              { tbl: 'tags', kind: 'uuid', keyCols: ['id'], fields: ['name'], naturalCols: ['name'] },
  category_rules:    {
    tbl: 'category_rules', kind: 'uuid', keyCols: ['id'],
    fields: ['priority', 'match_type', 'pattern', 'category', 'min_amount', 'max_amount'],
    naturalCols: ['match_type', 'pattern'], scopedBy: 'account_id',
  },
  name_rules:        {
    tbl: 'name_rules', kind: 'uuid', keyCols: ['id'],
    fields: ['match_type', 'pattern', 'replacement', 'min_amount', 'max_amount'],
    naturalCols: ['match_type', 'pattern'], scopedBy: 'account_id',
  },
  transaction_tags:  { tbl: 'transaction_tags', kind: 'link', keyCols: ['transaction_id', 'tag_id'], fields: [] },
  transactions:      { tbl: 'transactions', kind: 'annotation', keyCols: ['id'], fields: ['manual_category', 'display_name', 'ignored'] },
};

/** Co-owned + annotation tables, in the order triggers are installed. */
export const SYNC_TABLE_NAMES = Object.keys(SYNC_TABLES);

/**
 * Tables the server owns for Plaid-sourced rows. Plaid-owned rows arrive as
 * 'server_upsert' and are never pushed; only annotations on transactions are
 * client-writable. Client-owned rows (see below) live in the same tables.
 */
export const SERVER_OWNED_TABLES = ['accounts', 'transactions', 'balance_history'] as const;

// ── Client-owned rows (CSV / manual accounts, transactions, balances) ────────
//
// Ownership is per ROW, immutable after insert: transactions.source in
// plaid|csv|manual, accounts.origin in plaid|client. Balance rows inherit the
// owner of their account.
//
// Local ids differ from wire ids for accounts only: a client account keeps its
// local id (`manual-<uuid>` / `csv-acct-<uuid>`, which the UIs recognise) and
// carries its derived wire id (`acct-<uuidv5>`) in `accounts.wire_id`.
// Transactions use one id locally and on the wire.

/** accounts.origin: who owns the row. */
export const ORIGIN_CLIENT = 'client';
export const ORIGIN_PLAID = 'plaid';

/** Wire id prefixes the server enforces on client-origin writes. */
export const ACCOUNT_WIRE_PREFIX = 'acct-';

/** Account fields a client may write (plus `origin` on insert). */
export const CLIENT_ACCOUNT_FIELDS = [
  'name', 'type', 'subtype', 'institution_name', 'mask', 'nickname', 'owner', 'apr', 'excluded',
] as const;

/**
 * Transaction fields a client may write on rows it owns (source on insert
 * only). `category` and `pending` are never sent: category is derived locally,
 * pending is always 0.
 */
export const CLIENT_TX_FIELDS = [
  'account_id', 'date', 'name', 'merchant_name', 'amount', 'raw_category', 'source',
  'import_id', 'dedup_key', 'original_date', 'manual_category', 'display_name', 'ignored',
] as const;
/** The subset that is NOT an annotation (annotation triggers cover the rest). */
export const CLIENT_TX_BODY_FIELDS = [
  'account_id', 'date', 'name', 'merchant_name', 'amount', 'raw_category',
  'import_id', 'dedup_key', 'original_date',
] as const;

export const CLIENT_TX_SOURCES = ['csv', 'manual'] as const;
export const isClientTxId = (id: string): boolean => id.startsWith('manual-') || id.startsWith('csv-');

export const CLIENT_TABLES: Record<string, SyncTable> = {
  accounts:        { tbl: 'accounts', kind: 'client', keyCols: ['id'], fields: [...CLIENT_ACCOUNT_FIELDS] },
  transactions:    { tbl: 'transactions', kind: 'client', keyCols: ['id'], fields: [...CLIENT_TX_FIELDS] },
  balance_history: { tbl: 'balance_history', kind: 'client', keyCols: ['account_id', 'date'], fields: ['balance'] },
};

/** SQL: is accounts row `p` client-owned (origin column may not exist yet / be NULL)? */
export const clientAccountSql = (p: string): string =>
  `COALESCE(${p}.origin, CASE WHEN ${p}.item_id IS NULL THEN 'client' ELSE 'plaid' END) = 'client'`;

/** Wire key for a table's pk object (contract: categories {name}, ...). */
export const WIRE_KEYS: Record<string, string[]> = {
  categories: ['name'],
  hidden_categories: ['category'],
  settings: ['key'],
  household_members: ['id'],
  tags: ['id'],
  category_rules: ['id'],
  name_rules: ['id'],
  transaction_tags: ['transaction_id', 'tag_id'],
  transactions: ['id'],
};
