# Fungible operation-log sync protocol (client <-> sync server)

Status: implemented client side in `core/sync-*.ts`; the server side is built
in parallel. This file is the contract. Test double:
`tests/sync/fakeServer.ts` (implements everything below).

Scope: hosted mode only. BYOK installs never speak this protocol (no
network, no oplog, no triggers).

## Model

Every change to a synced row is an **operation**. A device appends operations
locally (SQLite triggers, so any process or code path is captured), pushes
them, and pulls everyone else's. Conflicts resolve by **hybrid logical clock
(HLC)**, **per field**.

Synced tables:

| table | owner | pk (wire) | synced fields |
|---|---|---|---|
| categories | co-owned | `{name}` | `flexibility` |
| hidden_categories | co-owned | `{category}` | (none: existence only) |
| settings | co-owned, allowlist | `{key}` | `value` |
| household_members | co-owned | `{id: uuid}` | `name, birth_year, sort_order` |
| tags | co-owned | `{id: uuid}` | `name` |
| category_rules | co-owned | `{id: uuid}` | `priority, match_type, pattern, category, min_amount, max_amount` |
| name_rules | co-owned | `{id: uuid}` | `match_type, pattern, replacement, min_amount, max_amount` |
| transaction_tags | co-owned | `{transaction_id, tag_id}` | (none) |
| transactions (`source='plaid'`) | server-owned + annotations | `{id: text}` (Plaid id) | client-writable: `manual_category, display_name, ignored` (upsert only) |
| transactions (`source` in `csv`,`manual`) | client-owned | `{id: text}` (`manual-`/`csv-` prefix) | `account_id, date, name, merchant_name, amount, raw_category, source` (insert only), `import_id, dedup_key, original_date, manual_category, display_name, ignored`; upsert + delete |
| accounts (`origin='plaid'`) | server-owned | pull only | |
| accounts (`origin='client'`) | client-owned | `{id: text}` (`acct-` prefix) | `name, type, subtype, institution_name, mask, nickname, owner, apr, excluded`, `origin` (insert only); upsert + delete |
| imports | client-owned | `{id: uuid}` | `file_name, file_hash, imported_at, row_count, account_id, min_date, max_date`; upsert + delete (`config`, `imported`, `skipped` stay local) |
| balance_history | owner follows the account | `{account_id, date}` | client-owned rows: `balance` (per-field LWW); upsert + delete |

`accounts.excluded` and `transactions.ignored` are JSON booleans on the wire
(`true`/`false`); the server rejects `0`/`1` with `forbidden_field`. Locally they
are stored 0/1; the client coerces on push and accepts either on apply.

`user_id` is never sent; the bearer token identifies the user.

Settings allowlist (client and server both enforce): `plaid_default_start_date`,
`pretax_monthly`. Any other key is `forbidden_field`. Never synced: canvases,
tag_rules, tag_rule_suppressions, account-scoped category/name rules
(`account_id IS NOT NULL` locally; the server has no account column), `device_id`.

### Ownership (client-owned rows)

Ownership is per ROW and immutable after insert: `transactions.source` in
`plaid|csv|manual`, `accounts.origin` in `plaid|client`; balance rows follow
their account. Plaid-owned rows are written by the server only (a client can
never create one: `forbidden_owner`); the client writes its own CSV/manual
accounts, manual transactions and manual balances, and annotations on
Plaid-owned transactions. Everything a client does not own is pull-only.

Rules the server enforces (and the client mirrors):

- ids: client-origin writes must use the `acct-` / `manual-` / `csv-` prefixes
  (anything else: `invalid_pk`); an INSERT must carry the owner column
  (`source` / `origin`) in `fields` and `source` may never change afterwards
  (`invalid_source`). Prefixed id without `source`: `invalid_source`.
- `amount` / `balance` must be finite with abs <= 1e12 (`invalid_amount`).
- a non-allowlisted field on a Plaid-owned row is `forbidden_owner`; an unknown
  field on a client row is `forbidden_field`.
- `category` and `pending` are never sent: category is derived locally from
  rules, pending is always 0.
- deletes of client rows are soft. Deleting a client account tombstones its
  client-owned transactions, balances (and imports) and appends **one delete op
  per child with `device_id` null**, which every device including the origin
  receives: apply idempotently, never echo.
- `balance_history` INSERTs must carry `origin: 'client'` in `fields` (the owner
  column is not inherited from the account; missing: `invalid_source`). An
  update need not send it; if sent it must equal the stored value.
- the server does NOT emit delete ops for `transaction_tags` links when a client
  transaction or account is deleted (no FK). The client sends explicit link
  deletes (pk `{transaction_id, tag_id}`) with the transaction delete, and for
  an account delete for the links of all its child transactions. Child
  transaction/balance deletes queued in the same batch as the account delete
  are dropped (they would come back `stale`); link deletes are kept. Import
  deletes do not cascade to rows.
- `row_missing` is also returned when the parent account does not exist on the
  server (yet, or any more): retryable, the op stays queued.
- `(account_id, dedup_key)` is unique among live client transactions
  (`conflict_unique`).
- batches are processed in rank order (accounts/tags, imports/co-owned,
  transactions/balances, transaction_tags); the client also sends parents first.

Wire kinds: client-owned rows arrive as `upsert`/`delete`; Plaid-owned rows as
`server_upsert`. The snapshot (`GET /sync/pull`) omits tombstones for every
table and carries `origin` / `source` / `dedup_key` / `import_id` per row.
`balance_history` ops are keyed `{account_id, date}`; `id` is no longer in op
fields (snapshot rows still carry one).

`merged_into` (accounts) and `absorbs` (transactions) are accepted but not
validated server-side and not used by this client yet.

### Ids

- `tags`, `category_rules`, `name_rules`: the uuid is **derived**, uuidv5-style
  SHA-1 over `fungible/<kind>/v1:<userId>:<natural key>` (tags: name; rules:
  `match_type:pattern`). Two devices creating the same tag/rule converge on one
  server row. The uuid never changes after a rename/edit. The server enforces
  unique `(user, name)` / `(user, match_type, pattern)` among live rows.
- `household_members`: wire id = SHA-1 derived from `(userId, localId)` where
  local ids are `self`, `spouse`, `child-N`. Ids the user does not derive (a
  foreign client's) are pinned to the next free local slot `child-16+`.
- `transactions`: Plaid rows use the Plaid-assigned text id; a client only sends
  annotation ops for transactions it received from the server. Manual
  transactions are `manual-<uuid>` (same id locally and on the wire).
- CSV `transactions`: `csv-<uuidv5>` over `fungible/csv_tx/v1:<userId>:<account
  wire id>:<dedup_key>` where `dedup_key` is `date|lower(name)|cents|ord` (ord =
  occurrence of an identical row within its file, so identical same-day rows
  stay distinct and two devices importing the same file agree). Locally an
  import writes `csv-<importId>-<row>`; the engine re-keys those in place the
  first cycle their account's wire id is known (children and queued ops
  follow, behind a `pre-adopt-sync` snapshot). A row moved to another account
  keeps its id; the dedup unique index is the real identity.
- `imports`: uuidv5 over `fungible/import/v1:<userId>:<file hash>:<account wire
  id>`. Local `imports.id` stays an integer; the uuid lives in
  `imports.wire_id`, and `transactions.import_id` is the integer locally and the
  import uuid on the wire.
- `accounts` (client-owned): wire id `acct-<uuidv5>` over `fungible/account/v1:
  <userId>:<norm institution>:<norm name>:<norm type>/<norm subtype>:<dup>`,
  derived once and never changed (a rename keeps it). Two devices that create
  the same account converge on one row. Locally the account keeps its original
  id (`manual-<uuid>` / `csv-acct-<uuid>`, which the UIs recognise) and the wire
  id lives in `accounts.wire_id`; a pulled client account gets a local id
  derived from the wire uuid in the same shapes. Plaid accounts use the server
  id on both sides.

### HLC

Fixed-width sortable string: `%015d-%05d-<device_id>` = zero-padded wall-clock
ms, counter, device id. String comparison **is** HLC order; the device id
breaks ties. The server rejects wall > its `now + 5 min` (`invalid_hlc`). A
client never mints a wall above `max(local now, last seen remote wall)` and
re-stamps rejected ops anchored on the newest remote wall it has seen.

## Operations

```
{ op_id, tbl, pk, kind, fields?, hlc }
kind: 'upsert' | 'delete'                       (client -> server)
      'upsert' | 'delete' | 'server_upsert'     (server -> client)
```

- `op_id`: client-generated unique id. The server is idempotent by `op_id`.
- `upsert` carries only the **changed** `fields` for an update and **all**
  synced fields for an insert/revive. A field value of `null` is a real value.
- `delete` has no fields. Deletes are soft on the server; an upsert with a
  newer HLC than the tombstone revives the row.
- `server_upsert` is how Plaid-owned data arrives. Plaid-removed transactions
  arrive as `server_upsert` with `fields.removed = true` (apply as removed, not
  delete); pending -> posted is `removed=true` on the old id plus a new row
  for the posted id (annotations on the pending row do not carry over).
  accounts / transactions / balance_history are never client-deleted.

### Per-field LWW (server)

For each field of an upsert, apply it iff `op.hlc > stored_field_hlc`. Row-level
HLC governs only existence/delete: a delete applies iff newer than every field
HLC of the row; an upsert newer than the tombstone revives. An op that wins no
field (and revives nothing) is `stale`: recorded as superseded, consumes a seq.

## Endpoints

Auth: `Authorization: Bearer <access token>`. `401` unauthenticated, `402`
not paid (any endpoint).

### `POST /sync/ops`

```
request  { device_id, ops: [ {op_id, tbl, pk, kind, fields?, hlc} ... ] }   max 500
response 200 { accepted: [op_id], rejected: [ {op_id, reason, detail?} ], server_seq }
```

Each op is applied in its own savepoint; a bad op does not poison the batch.
Per-op results are in `accepted` / `rejected`. `detail` (`{field, expected}`) is
present for `forbidden_field`, `forbidden_owner`, `invalid_amount`,
`invalid_source` and `invalid_pk`; the client surfaces it on the `errors` entry of
`runSyncCycle` (`PushConflict.detail`, rendered by `formatPushError` as e.g.
`forbidden_field: excluded expected boolean`). Reject reasons:

| reason | client behaviour |
|---|---|
| `forbidden_table` | permanent; reported once; counted in `rejectedCount` |
| `forbidden_field` | permanent (settings key outside allowlist, unknown field) |
| `forbidden_owner` | permanent: write to a Plaid-owned column/row, or an attempt to create a Plaid-owned row |
| `invalid_source` | permanent: owner column missing on insert, changed, or inconsistent with the id prefix |
| `invalid_amount` | permanent: non-finite or abs > 1e12 |
| `invalid_pk` | permanent (also: client-origin write with an id that lacks its prefix) |
| `conflict_unique` | permanent for this op; the colliding server row arrives by pull and the local row adopts its uuid (natural-key adoption); reported once |
| `stale` | informational: a newer write holds the field(s). Op marked superseded; `CycleStats.superseded++` |
| `row_missing` | **retryable**: a partial `transactions` op (or `transaction_tags` whose tag is not there yet) arrived before its row, or a client transaction/balance whose parent account is not on the server. Op stays queued; retried every cycle |
| `invalid_hlc` | wall too far ahead of server time (or malformed). Client re-stamps and retries; `CycleStats.clockSkew = true` |
| `server_error` | retryable |

`tags` upserts are sent before `transaction_tags` ops within a batch; the
server treats a missing tag as `row_missing`.

### `GET /sync/ops?since=<server_seq>&limit=<n>`

```
200 { ops: [ {server_seq, op_id, device_id, tbl, pk, kind, fields, hlc} ], next_seq, has_more }
410 { error: 'resync_required' }      cursor older than the server's retained log
```

- Ordered by `server_seq`; includes the caller's own ops (the client skips
  `op_id`s it already holds).
- `server_seq` is an **opaque, per-user, monotonically increasing integer**
  (bigint, gap-free in commit order). Clients store it as a string, never do
  arithmetic on it, never assume global ordering, and keep it per user
  (`_sync_state.cursor:<userId>`).
- Page until `has_more = false`. The client applies a page and advances the
  cursor in **one local transaction**, so a crash resumes at the last
  committed page and re-applying is harmless.

### `GET /sync/pull` (bootstrap snapshot)

Existing endpoint, additive field `server_seq`:

```
200 { server_seq, tables: { <table>: { rows: [...], deletes: [...] } } }
```

First-time and adopting clients (and any client that got a 410) pull the
snapshot, apply it as lowest-priority base state, run BYOK adoption, then
continue with `GET /sync/ops?since=<server_seq>`. Local unpushed ops are kept.
A device does not mix `/sync/push` and `/sync/ops` after cutover.

## Client behaviour notes

- **Capture**: AFTER INSERT/UPDATE/DELETE triggers on the synced tables write
  `_oplog` rows regardless of the writing process. They are suppressed while
  the engine applies pulled ops (`_sync_state.applying`, set and cleared inside
  the same write transaction). Triggers are installed once, by
  `enableHostedMode` (`migrate(2, ...)` after a `pre-enable-sync` snapshot,
  fail closed), and stay installed after a switch back to BYOK so edits made
  there push on re-entry.
- **Backfill**: enabling queues full upserts for existing local rows so the
  first push uploads local state (account-scoped rules and denied settings
  excluded). On first connection the server's value wins over these backfilled
  copies; real local edits made after enabling still win by HLC.
- **Coalescing**: pending upserts of one row with no delete between are merged
  into one op before pushing.
- **Local-only rows**: annotations/links on Plaid transactions this device never
  received from the server are held (not sent, not "pending", not rejected).
  CSV-source transactions are held too until their ids are derivable (they are
  counted in `SyncInfo.localOnlyCount` so a UI can say "N imported rows not yet
  synced"); manual transactions and client accounts/balances are synced.
- **Client-owned capture**: triggers on `accounts` (origin client), manual/csv
  `transactions` and balances of client accounts, installed by migration 3 with
  the `accounts.origin` / `accounts.wire_id` columns (hosted enable only; a BYOK
  database never gets them). Enable backfills existing client accounts, manual
  transactions and balances, parents first, after the snapshot.
- **Undo import**: per-row deletes then the import's delete (no bulk op). A
  pulled import delete removes the import and any of its rows still present.
- **Duplicate CSV row**: `conflict_unique` is reported once; the colliding
  server row arrives by pull and the local copy adopts its id (as does a pulled
  row whose `(account, dedup_key)` a local row already holds).
- **Cascade**: a pending account delete makes the child ops queued in the same
  push moot (the server cascades and emits the child deletes); applying a
  pulled account delete removes its children locally.
- **Snapshot**: client rows the server acknowledged earlier but no longer lists
  are deleted locally after a resync (tombstones are omitted); rows with a
  pending or held local op are kept.
- **Volume**: no bulk op; per-row upserts coalesced locally, <= 500 per
  batch, idempotent by op_id, so a killed push resumes from what is still
  pending.
- **Client accounts vs Plaid accounts**: a client account that never reached
  the server and unambiguously matches a pulled Plaid account is adopted like a
  local Plaid account (re-keyed; its manual transactions follow). One already
  on the server stays beside its twin until a client-driven merge exists.
- **BYOK adoption**: see `core/sync-adopt.ts` (institution+mask+type for
  accounts; one-to-one amount / date +-3d / name for transactions; annotations
  and tag links move to the server row; unmatched rows stay local-only).
  Preceded by a `pre-adopt-sync` snapshot, fail closed.
- **Known limitation**: a partial upsert that revives a row this device already
  deleted cannot recreate it (required fields missing) and is counted in
  `superseded`; tags (single field) are unaffected.
