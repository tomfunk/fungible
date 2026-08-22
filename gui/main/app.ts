import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from '../../core/paths.js';
import { initDb } from '../../core/db.js';
import { backupDb } from '../../core/backup.js';
import { rebuildDisplayNames } from '../../core/rename.js';
import { syncAll } from '../../core/sync.js';
import { setSyncResult } from '../../core/sync-status.js';
import { plaidErrorMessage } from '../../core/plaid.js';
import { registerBridge } from './bridge.js';
import { registerRefreshPush } from './refresh-ipc.js';
import { registerSyncStatusPush } from './sync-status-ipc.js';
import { registerAgentIpc, rejectPendingConfirms } from './agent-ipc.js';
import { registerSyncIpc } from './sync-ipc.js';
import { cancelActivePlaidLink } from './plaid-link.js';
import { buildMenu } from './menu.js';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const isDemo = !!process.env.FUNGIBLE_DEMO;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await initDb();
      if (isDemo) {
        const { seedDemo } = await import('../../scripts/seed-demo.js');
        await seedDemo();
      } else {
        backupDb().catch(() => {});
      }
      // Fire-and-forget: a full-table display-name rebuild must not block first paint.
      rebuildDisplayNames().catch((err) => console.error('[gui] display-name rebuild failed:', err));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dialog.showErrorBox('fungible — database error', msg);
      app.quit();
      return;
    }

    registerBridge();
    registerRefreshPush();
    registerSyncStatusPush();
    registerAgentIpc();
    registerSyncIpc();
    buildMenu();
    createWindow();

    // Background startup sync: record its outcome in the shared store so failures
    // surface (banner + badges) instead of only logging to the main console.
    if (!isDemo) {
      syncAll()
        .then(setSyncResult)
        .catch((err) => {
          console.error('[gui] background sync failed:', err);
          setSyncResult([{ itemId: '', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: plaidErrorMessage(err) }]);
        });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

const WINDOW_STATE_PATH = join(DATA_DIR, 'gui-window.json');

type WindowState = { width: number; height: number; x?: number; y?: number };

function loadWindowState(): WindowState {
  try {
    return { width: 1280, height: 840, ...JSON.parse(readFileSync(WINDOW_STATE_PATH, 'utf-8')) };
  } catch {
    return { width: 1280, height: 840 };
  }
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    ...state,
    minWidth: 900,
    minHeight: 600,
    title: 'fungible',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', () => {
    try {
      writeFileSync(WINDOW_STATE_PATH, JSON.stringify(win.getNormalBounds()), 'utf-8');
    } catch {
      /* non-fatal */
    }
  });
  win.on('closed', () => {
    rejectPendingConfirms();
    cancelActivePlaidLink();
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}
