import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { dailyKeepDays, snapshot, recordLastRun, getBackupStatus, type BackupStatus } from './snapshot.js';

export { getBackupStatus, type BackupStatus };

let failureLogged = false;

/**
 * Daily backup entry point (TUI, GUI, MCP and API startup call this
 * fire-and-forget). Never throws: the outcome is recorded in
 * backups/last-run.json (see getBackupStatus) and a failure is logged once per
 * process. FUNGIBLE_BACKUP_DAYS is the number of daily snapshots kept; <= 0
 * disables daily snapshots only (named snapshots still work).
 *
 * Backups live next to the database and do not protect against disk loss.
 */
export async function backupDb(): Promise<void> {
  if (dailyKeepDays() <= 0) return;
  if (!fs.existsSync(path.join(DATA_DIR, 'fungible.db'))) return;
  const at = new Date();
  try {
    const r = await snapshot('daily', { dataDir: DATA_DIR, now: at });
    recordLastRun(DATA_DIR, { at: at.toISOString(), ok: true, reason: 'daily', dir: r.dir });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordLastRun(DATA_DIR, { at: at.toISOString(), ok: false, reason: 'daily', error: msg });
    if (!failureLogged) {
      failureLogged = true;
      console.error(`fungible: daily backup failed: ${msg}`);
    }
  }
}
