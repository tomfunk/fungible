import type { Client } from '@libsql/client';
import { db } from './db.js';
import { migrate, getDeviceId } from './migrate.js';
import { installStatements, oplogInstalled, collectBackfill, queueOpsStatements, OPLOG_MIGRATION_VERSION } from './sync-oplog.js';
import { setBeforeAdoptHook } from './sync-adopt.js';
import { login, register, logout, sessionUserId, isAuthConfigured } from './auth-client.js';

// Sync mode + per-install session state. Portable (no node:* imports) so the
// TUI, desktop GUI, MCP server and the web app share one implementation.
//
//   byok      the default. No oplog, no triggers, no network, product SQL untouched.
//   hosted    opt-in. Triggers log local edits; the engine pushes and pulls ops.
//
// Mode, user_id, cursor and last_sync_at live in `_sync_state` -- per install,
// never synced, and deliberately NOT in `settings` (which is synced).
//
// Switching is lossless in both directions. Enabling installs the oplog and
// triggers (once, behind a snapshot; fail closed). Disabling only flips the
// mode flag: the triggers stay installed and keep logging, so edits made while
// in BYOK push on re-entry, and the cursor survives so the next pull only
// fetches what changed.

export type SyncMode = 'byok' | 'hosted';

export class SyncError extends Error {
  constructor(public code: string, public status?: number) {
    super(code);
    this.name = 'SyncError';
  }
}

// ── _sync_state accessors (tolerant of the table not existing) ───────────────

export async function readSyncState(key: string, client: Client = db): Promise<string | null> {
  try {
    const res = await client.execute({ sql: 'SELECT value FROM _sync_state WHERE key = ?', args: [key] });
    return (res.rows[0] as unknown as { value: string } | undefined)?.value ?? null;
  } catch {
    return null; // BYOK database: _sync_state does not exist
  }
}

export async function writeSyncState(key: string, value: string, client: Client = db): Promise<void> {
  await client.execute({
    sql:  `INSERT INTO _sync_state (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

export async function clearSyncState(key: string, client: Client = db): Promise<void> {
  await client.execute({ sql: 'DELETE FROM _sync_state WHERE key = ?', args: [key] });
}

export async function getSyncMode(client: Client = db): Promise<SyncMode> {
  const mode = await readSyncState('mode', client);
  return mode === 'hosted' ? 'hosted' : 'byok';
}

/** The server_seq cursor is kept per user: another account never inherits it. */
export const cursorKey = (userId: string): string => `cursor:${userId}`;

export type SyncSession = {
  mode: SyncMode;
  userId: string | null;
  cursor: string | null;
  lastSyncAt: string | null;
};

export async function getSyncSession(client: Client = db): Promise<SyncSession> {
  const userId = await readSyncState('user_id', client);
  return {
    mode:       await getSyncMode(client),
    userId,
    cursor:     userId ? await readSyncState(cursorKey(userId), client) : null,
    lastSyncAt: await readSyncState('last_sync_at', client),
  };
}

// ── Account switch ───────────────────────────────────────────────────────────

/**
 * Forget everything that tied this database to a previous account:
 * cursors, server identities, the old operation log. Local rows are then
 * re-queued as ops so the new account receives the user's local data.
 */
export async function resetForNewAccount(client: Client = db): Promise<void> {
  const deletes = [
    `DELETE FROM _sync_state WHERE key LIKE 'cursor:%' OR key LIKE 'member_map:%' OR key LIKE 'account_map:%'
       OR key IN ('last_sync_at', 'bootstrapped', 'adopt_backup_done', 'hlc_remote_wall')`,
    'DELETE FROM _oplog',
    'DELETE FROM _sync_server_tx',
  ];
  const stmts: import('@libsql/client').InStatement[] = [...deletes];
  // Derived ids embed the user id: they are re-derived for the new account.
  for (const t of ['tags', 'category_rules', 'name_rules']) {
    stmts.push(`UPDATE ${t} SET uuid = NULL`);
  }
  stmts.push(...(await queueOpsStatements(client, await collectBackfill(client))));
  await client.batch(stmts, 'write');
}

// ── Mode switches ────────────────────────────────────────────────────────────

export type EnableOptions = {
  /** The account user this install syncs as (JWT `sub`). */
  userId: string;
  /**
   * Snapshot taken before the oplog schema is first installed (and reused for
   * the first adoption pass). Default: core/snapshot.ts `snapshot(reason)`;
   * a throw aborts the enable with the database untouched. Pass `false` only
   * where there is no on-disk database to protect (the browser DB).
   */
  snapshot?: false | ((reason: string) => Promise<unknown>);
  /** @deprecated alias of `snapshot` (the older hook form). */
  beforeMigrate?: () => Promise<void>;
  /** Data dir for the default snapshot. */
  dataDir?: string;
  /** Accept that the stored user_id differs: wipe sync identity, push local data to the new account. */
  resetForNewAccount?: boolean;
  client?: Client;
};

export async function enableHostedMode(opts: EnableOptions): Promise<void> {
  const client = opts.client ?? db;
  const stored = await readSyncState('user_id', client);
  const mismatch = stored != null && stored !== opts.userId;
  if (mismatch && !opts.resetForNewAccount) throw new SyncError('account_mismatch');

  const snap: false | ((reason: string) => Promise<unknown>) | undefined =
    opts.snapshot !== undefined ? opts.snapshot
    : opts.beforeMigrate ? async () => { await opts.beforeMigrate!(); }
    : undefined;

  // The same snapshot guards the first adoption pass, which re-keys local
  // account/transaction ids when the first server rows arrive.
  if (snap === false) setBeforeAdoptHook(async () => {});
  else if (snap) setBeforeAdoptHook(async () => { await snap('pre-adopt-sync'); });

  if (!(await oplogInstalled(client))) {
    // device_id is read inside the migration body, i.e. after the snapshot,
    // so a failed snapshot leaves the database exactly as it was.
    await migrate(
      OPLOG_MIGRATION_VERSION, 'sync-oplog',
      async (c) => installStatements(c, await getDeviceId(c)),
      { client, snapshot: snap, reason: 'pre-enable-sync', dataDir: opts.dataDir },
    );
  }

  if (mismatch) await resetForNewAccount(client);
  await writeSyncState('user_id', opts.userId, client);
  await writeSyncState('mode', 'hosted', client);
}

// Back to BYOK. Triggers keep logging, the cursor and op log are kept (so the
// next enable resumes exactly where this left off); only the mode flag flips.
// Token clearing is the caller's job (disconnectAccount does it).
export async function disableHostedMode(client: Client = db): Promise<void> {
  if (!(await oplogInstalled(client))) return; // never enabled: already BYOK
  await writeSyncState('mode', 'byok', client);
}

// ── Auth + mode in one step (what a Settings screen calls) ───────────────────

export type ConnectOptions = Omit<EnableOptions, 'userId'> & { createAccount?: boolean };

export async function connectAccount(email: string, password: string, opts: ConnectOptions = {}): Promise<void> {
  if (opts.createAccount) await register(email, password);
  else await login(email, password);
  const userId = await sessionUserId();
  if (!userId) throw new SyncError('not_authenticated');
  try {
    await enableHostedMode({ ...opts, userId });
  } catch (e) {
    // Don't leave a live session behind for an account we refused to bind.
    if (e instanceof SyncError && e.code === 'account_mismatch' && isAuthConfigured()) logout();
    throw e;
  }
}

export async function disconnectAccount(client: Client = db): Promise<void> {
  await disableHostedMode(client);
  if (isAuthConfigured()) logout();
}
