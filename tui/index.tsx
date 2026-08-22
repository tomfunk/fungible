import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env'), quiet: true });
import React from 'react';
import { render } from 'ink';
import { writeFileSync } from 'node:fs';
import stripAnsi from 'strip-ansi';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { syncAll } from '../core/sync.js';
import { setSyncResult } from '../core/sync-status.js';
import { notifyChange } from '../core/refresh.js';
import { plaidErrorMessage } from '../core/plaid.js';
import { rebuildDisplayNames } from '../core/rename.js';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { startMcpHttpServer } from '../mcp/http.js';
import { startApiServer } from '../api/server.js';

// ── Screen capture ─────────────────────────────────────────────────────────────
const SCREEN_PATH = join(DATA_DIR, 'screen.txt');
let _captureTimer: ReturnType<typeof setTimeout> | undefined;
let _lastChunk = '';
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as typeof process.stdout.write) = function (chunk, enc?, cb?) {
  const result = (_origWrite as any)(chunk, enc, cb);
  _lastChunk = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
  clearTimeout(_captureTimer);
  _captureTimer = setTimeout(() => {
    const clean = stripAnsi(_lastChunk).trimEnd();
    if (clean) try { writeFileSync(SCREEN_PATH, clean, 'utf-8'); } catch { /* ignore */ }
  }, 80);
  return result;
};

const isDemo = process.argv.includes('--demo');

await initDb();
if (!isDemo) backupDb().catch(() => {});

if (process.argv.includes('--setup')) {
  render(<Setup />);
} else {
  if (isDemo) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    await seedDemo();
  }
  await rebuildDisplayNames();
  if (!isDemo) {
    // Startup sync runs in the background; feed its outcome to the shared store
    // so failures surface (global banner + Accounts badges) instead of vanishing.
    // notifyChange() bumps refreshKey so screens already mounted when the sync
    // lands re-query — without it, the Accounts page keeps showing the list it
    // read before the first sync created any account rows.
    syncAll()
      .then((results) => { setSyncResult(results); notifyChange(); })
      .catch((err) => {
        setSyncResult([
          { itemId: '', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: plaidErrorMessage(err) },
        ]);
        notifyChange();
      });
  }

  const mcpPort = parseInt(process.env.FUNGIBLE_MCP_PORT ?? '3741', 10);
  const apiPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
  startMcpHttpServer(mcpPort);
  startApiServer(apiPort, { quiet: true });

  render(<App />);
}
