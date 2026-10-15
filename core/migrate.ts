import type { Client, InStatement } from '@libsql/client';
import { db } from './db.js';
import { SCHEMA_USER_VERSION } from './schema-version.js';

// Versioned, snapshot-guarded schema migrations.
//
// `migrate(version, name, fn)` is the single door for any change that adds or
// rewrites schema/sync state beyond what initDb's idempotent bootstrap does.
// It is idempotent (applied versions live in `_migrations`), takes a backup
// snapshot before running, and FAILS CLOSED: if the snapshot cannot be taken,
// nothing runs and the database is untouched.
//
// Nothing here runs at startup. A BYOK database has an empty migration list, so
// `_migrations` is never even created for it.
//
// Portability: this module imports no node:* module. The default snapshot is
// loaded lazily from ./snapshot.js (Node only). A browser build must pass
// `snapshot: false` explicitly -- there is nothing on disk to protect.

export class MigrateError extends Error {
  constructor(public code: 'snapshot_failed' | 'unknown_version' | 'migration_failed', message: string) {
    super(message);
    this.name = 'MigrateError';
  }
}

export type MigrationBody = (client: Client) => Promise<InStatement[] | void> | InStatement[] | void;

export interface MigrateOptions {
  client?: Client;
  /**
   * Snapshot to take before running. Default: core/snapshot.ts snapshot() with
   * reason `pre-migrate-<version>`. `false` skips it (browser DB, tests).
   * A custom function must throw to abort.
   */
  snapshot?: false | ((reason: string) => Promise<unknown>);
  /** Reason label override (default `pre-migrate-<version>`). */
  reason?: string;
  /** Data dir for the default snapshot (defaults to the app data dir). */
  dataDir?: string;
}

export interface MigrateResult {
  applied: boolean;
  version: number;
}

async function defaultSnapshot(client: Client, dataDir: string | undefined, reason: string): Promise<void> {
  const mod = await import('./snapshot.js');
  await mod.snapshot(reason, { client, ...(dataDir ? { dataDir } : {}) });
}

export async function appliedVersions(client: Client = db): Promise<number[]> {
  try {
    const res = await client.execute('SELECT version FROM _migrations ORDER BY version');
    return (res.rows as unknown as { version: number }[]).map((r) => Number(r.version));
  } catch {
    return []; // no _migrations table: nothing applied
  }
}

export async function isMigrationApplied(version: number, client: Client = db): Promise<boolean> {
  return (await appliedVersions(client)).includes(version);
}

/**
 * Run migration `version` once. If `fn` returns statements they are executed in
 * a single transaction together with the `_migrations` record, so a failure
 * leaves the database as it was. If `fn` does its own writes it must itself be
 * idempotent (a crash before the record is written re-runs it).
 */
export async function migrate(
  version: number,
  name: string,
  fn: MigrationBody,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  if (!Number.isInteger(version) || version < 1) {
    throw new MigrateError('unknown_version', `invalid migration version ${version}`);
  }
  if (version > SCHEMA_USER_VERSION) {
    throw new MigrateError('unknown_version', `migration ${version} (${name}) is newer than this build understands (${SCHEMA_USER_VERSION})`);
  }
  const client = opts.client ?? db;
  if ((await appliedVersions(client)).includes(version)) return { applied: false, version };

  const reason = opts.reason ?? `pre-migrate-${version}`;
  if (opts.snapshot !== false) {
    try {
      if (opts.snapshot) await opts.snapshot(reason);
      else await defaultSnapshot(client, opts.dataDir, reason);
    } catch (e) {
      throw new MigrateError('snapshot_failed', `migration ${version} (${name}) not run: ${reason} snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Another process may have applied it while we were snapshotting.
  if ((await appliedVersions(client)).includes(version)) return { applied: false, version };

  try {
    await client.execute(
      'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const stmts = (await fn(client)) ?? [];
    await client.batch([
      ...stmts,
      {
        sql: 'INSERT OR IGNORE INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
        args: [version, name, new Date().toISOString()],
      },
    ], 'write');
    const uv = await client.execute('PRAGMA user_version');
    const cur = Number((uv.rows[0] as unknown as { user_version: number | bigint }).user_version);
    if (cur < version) await client.execute(`PRAGMA user_version = ${version}`);
  } catch (e) {
    throw new MigrateError('migration_failed', `migration ${version} (${name}) failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { applied: true, version };
}

// ── device_id ────────────────────────────────────────────────────────────────

/** Settings key holding this install's device id. Not in the synced allowlist. */
export const DEVICE_ID_KEY = 'device_id';

/**
 * Stable per-install id, generated lazily on first use. Local-only: it is not
 * in the synced-settings allowlist, so it never leaves the machine as a
 * setting (it is sent only as the origin tag on operations).
 */
export async function getDeviceId(client: Client = db): Promise<string> {
  const read = async (): Promise<string | null> => {
    const r = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [DEVICE_ID_KEY] });
    return (r.rows[0] as unknown as { value: string } | undefined)?.value ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  await client.execute({
    sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
    args: [DEVICE_ID_KEY, globalThis.crypto.randomUUID()],
  });
  return (await read())!; // INSERT OR IGNORE: a concurrent writer's id wins, consistently
}
