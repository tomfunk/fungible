import { BrowserWindow } from 'electron';
import { onSyncStatus, getSyncFailures } from '../../core/sync-status.js';

// Mirrors refresh-ipc.ts, but carries a payload: on every sync-status change,
// push the current failures to every open window so the renderer's banner and
// row badges update without a round-trip. Initial state is pulled via
// api.sync.getStatus() when a provider mounts (covers a sync that resolved first).
export function registerSyncStatusPush() {
  onSyncStatus(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync-status', getSyncFailures());
    }
  });
}
