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
  | 'annotation';

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

/** Tables pulled only; they arrive as 'server_upsert' ops and are never pushed. */
export const SERVER_OWNED_TABLES = ['accounts', 'transactions', 'balance_history'] as const;

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
