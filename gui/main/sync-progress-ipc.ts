import { BrowserWindow } from 'electron';
import { onSyncProgress, isSyncInProgress } from './sync-progress.js';

// Mirrors sync-status-ipc.ts: push the current in-progress flag to every open
// window whenever it changes, so every sync entry point (startup, a Plaid
// Link follow-up sync, or a Sync button on any screen) shows "Syncing…"
// wherever the renderer renders it, not just where it was triggered. Initial
// state is pulled via api.sync.isSyncing() when a provider mounts (covers a
// sync already running before it subscribed — e.g. the startup sync starting
// before the renderer has finished loading).
export function registerSyncProgressPush() {
  onSyncProgress(() => {
    const syncing = isSyncInProgress();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync-progress', syncing);
    }
  });
}
