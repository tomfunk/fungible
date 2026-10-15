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
| transactions | server-owned + annotations | `{id: text}` (Plaid id) | client-writable: `manual_category, display_name, ignored` |
| accounts, balance_history | server-owned | pull only | |

`user_id` is never sent; the bearer token identifies the user.

Settings allowlist (client and server both enforce): `plaid_default_start_date`,
`pretax_monthly`. Any other key is `forbidden_field`. Never synced: canvases,
tag_rules, tag_rule_suppressions, account-scoped category/name rules
(`account_id IS NOT NULL` locally; the server has no account column), `device_id`.

### Ids

- `tags`, `category_rules`, `name_rules`: the uuid is **derived**, uuidv5-style
  SHA-1 over `fungible/<kind>/v1:<userId>:<natural key>` (tags: name; rules:
  `match_type:pattern`). Two devices creating the same tag/rule converge on one
  server row. The uuid never changes after a rename/edit. The server enforces
  unique `(user, name)` / `(user, match_type, pattern)` among live rows.
- `household_members`: wire id = SHA-1 derived from `(userId, localId)` where
  local ids are `self`, `spouse`, `child-N`. Ids the user does not derive (a
  foreign client's) are pinned to the next free local slot `child-16+`.
- `transactions`: the Plaid-assigned text id. A client only sends annotation
  ops for transactions it received from the server.

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
response 200 { accepted: [op_id], rejected: [ {op_id, reason} ], server_seq }
```

Each op is applied in its own savepoint; a bad op does not poison the batch.
Per-op results are in `accepted` / `rejected`. Reject reasons:

| reason | client behaviour |
|---|---|
| `forbidden_table` | permanent; reported once; counted in `rejectedCount` |
| `forbidden_field` | permanent (settings key outside allowlist, unknown field) |
| `invalid_pk` | permanent |
| `conflict_unique` | permanent for this op; the colliding server row arrives by pull and the local row adopts its uuid (natural-key adoption); reported once |
| `stale` | informational: a newer write holds the field(s). Op marked superseded; `CycleStats.superseded++` |
| `row_missing` | **retryable**: a partial `transactions` op (or `transaction_tags` whose tag is not there yet) arrived before its row. Op stays queued; retried every cycle |
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
- **Local-only rows**: annotations/links on transactions this device never
  received from the server are held (not sent, not "pending", not rejected).
- **BYOK adoption**: see `core/sync-adopt.ts` (institution+mask+type for
  accounts; one-to-one amount / date +-3d / name for transactions; annotations
  and tag links move to the server row; unmatched rows stay local-only).
  Preceded by a `pre-adopt-sync` snapshot, fail closed.
- **Known limitation**: a partial upsert that revives a row this device already
  deleted cannot recreate it (required fields missing) and is counted in
  `superseded`; tags (single field) are unaffected.
