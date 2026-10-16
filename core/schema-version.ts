/**
 * `PRAGMA user_version` stamped by initDb on a database that predates the
 * pragma. A BYOK database stays at this value forever: no migration touches it.
 */
export const BASE_USER_VERSION = 1;

/**
 * Highest on-disk schema version this build understands. Purely additive:
 * builds that predate the pragma ignore it. Snapshots record the database's
 * user_version in their manifest and restore refuses a snapshot written by a
 * newer build (user_version greater than this), since this build cannot know
 * that schema. core/migrate.ts raises a database's user_version to the version
 * of each migration it applies, so bump this when adding a migration.
 *
 *   1  base schema (initDb)
 *   2  sync operation log + triggers (installed only when hosted sync is enabled)
 *   3  client-owned rows: accounts.origin / wire_id + triggers (hosted sync only)
 *   4  synced imports (imports.wire_id + triggers) and CSV row backfill (hosted sync only)
 */
export const SCHEMA_USER_VERSION = 4;
