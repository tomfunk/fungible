import { configureAuth, hasSession, sessionEmail, isAuthConfigured } from '../../core/auth-client.js';
import { envFileAuthAdapter } from '../../core/auth-env-file.js';
import {
  configureSync, runSyncCycle, startBackgroundSync, stopBackgroundSync, getSyncInfo, type CycleStats,
} from '../../core/sync-client.js';
import { getSyncMode, connectAccount, disconnectAccount, SyncError } from '../../core/sync-mode.js';
import { MigrateError } from '../../core/migrate.js';
import { notifyChange } from '../../core/refresh.js';
import type { AccountState, ConnectOptions, ConnectResult, CycleSummary } from '../shared/account-types.js';

// Desktop account / sync bridge. Electron-free so tests can import it directly.
//
// Gated exactly like the TUI: nothing here is active unless FUNGIBLE_SYNC_URL is set
// (and the app is not in demo mode). With it unset the desktop app is the plain
// BYOK app: no sync UI, no background sync, no auth configured.

export function summarize(s: CycleStats, held = 0): CycleSummary {
  return {
    pushed: s.pushed,
    pulled: s.pullApplied,
    superseded: s.superseded,
    retrying: s.retrying ?? 0,
    held,
    rejected: s.errors.length,
    clockSkew: s.clockSkew === true,
  };
}

/** Wire the engine when FUNGIBLE_SYNC_URL is configured. Returns whether sync is enabled. */
export function configureSyncFromEnv(opts: { demo?: boolean } = {}): boolean {
  const url = process.env.FUNGIBLE_SYNC_URL;
  if (!url || opts.demo) return false;
  configureAuth(envFileAuthAdapter(), url);
  configureSync(url);
  return true;
}

/** Start syncing for an already-connected install; inert (and silent) otherwise. */
export async function startSyncBackgroundIfConnected(): Promise<void> {
  if (!isAuthConfigured()) return;
  if ((await getSyncMode()) !== 'hosted' || !hasSession()) return;
  startBackgroundSync();
  runSyncCycle().then(() => notifyChange()).catch((err) => console.error('[sync] initial cycle:', err));
}

export function stopSyncBackground(): void {
  stopBackgroundSync();
}

async function cycleSummary(): Promise<CycleSummary> {
  const stats = await runSyncCycle();
  const info = await getSyncInfo();
  notifyChange();
  return summarize(stats, info.heldCount);
}

export const account = {
  /** null when FUNGIBLE_SYNC_URL is not configured: the renderer shows no sync UI at all. */
  getSyncState: async (): Promise<AccountState | null> => {
    if (!isAuthConfigured()) return null;
    const info = await getSyncInfo();
    return {
      platform: 'desktop',
      mode: info.mode,
      signedIn: hasSession(),
      email: info.mode === 'hosted' ? (sessionEmail() ?? null) : null,
      lastSyncAt: info.lastSyncAt,
      pendingCount: info.pendingCount,
      heldCount: info.heldCount,
      rejectedCount: info.rejectedCount,
      persistent: null,
    };
  },

  /**
   * Log in or register, bind this database to the account and run the first
   * cycle. No beforeMigrate hook is passed: enabling takes its own fail-closed
   * safety snapshot (a failure aborts with the database untouched).
   */
  connect: async (email: string, password: string, opts: ConnectOptions = {}): Promise<ConnectResult> => {
    if (!isAuthConfigured()) throw new Error('Sync is not configured (FUNGIBLE_SYNC_URL is not set).');
    try {
      await connectAccount(email.trim(), password, {
        createAccount: !!opts.createAccount,
        resetForNewAccount: !!opts.resetForNewAccount,
      });
    } catch (e) {
      if (e instanceof SyncError && e.code === 'account_mismatch') return { status: 'account_mismatch' };
      if (e instanceof MigrateError && e.code === 'snapshot_failed') {
        return {
          status: 'snapshot_failed',
          message: `Could not take a safety backup, so sync was not enabled. ${e.message}`,
        };
      }
      throw e;
    }
    startBackgroundSync();
    return { status: 'connected', summary: await cycleSummary() };
  },

  syncNow: async (): Promise<CycleSummary> => {
    if (!isAuthConfigured()) throw new Error('Sync is not configured (FUNGIBLE_SYNC_URL is not set).');
    return cycleSummary();
  },

  /** Back to BYOK. Local data, cursor and queued edits stay. */
  disconnect: async (): Promise<void> => {
    stopBackgroundSync();
    await disconnectAccount();
  },
};
