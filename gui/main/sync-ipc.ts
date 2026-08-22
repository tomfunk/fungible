import { ipcMain } from 'electron';
import { refreshTransactions } from '../../core/transactions-refresh.js';
import { mergeSyncResult } from '../../core/sync-status.js';

// On-demand /transactions/refresh gets its own channel rather than a registry
// entry: the poll runs for minutes and streams progress, so the renderer needs
// a progress push and a cancel path, not a single request/response call.
export function registerSyncIpc() {
  // itemId → the controller aborting its in-flight poll, so a later cancel or a
  // window close can stop the timers and the sync it left running.
  const inflight = new Map<string, AbortController>();

  ipcMain.handle('sync:refresh', async (e, itemId: string) => {
    inflight.get(itemId)?.abort(); // never run two polls for one item at once
    const controller = new AbortController();
    inflight.set(itemId, controller);
    const send = (...args: unknown[]) => {
      if (!e.sender.isDestroyed()) e.sender.send('sync:refresh-progress', ...args);
    };
    try {
      const result = await refreshTransactions(itemId, {
        signal: controller.signal,
        onProgress: (progress) => send(progress),
      });
      // A check that ran is a real sync outcome: scoped to this item so it badges
      // its ⚠ (or clears a stale one) without touching other connections.
      if (result.syncResults.length > 0) mergeSyncResult(result.syncResults, [itemId]);
      return result;
    } finally {
      inflight.delete(itemId);
    }
  });

  // Esc / navigating away aborts the poll instead of leaving it running.
  ipcMain.handle('sync:refresh-cancel', (_e, itemId: string) => {
    inflight.get(itemId)?.abort();
  });
}
