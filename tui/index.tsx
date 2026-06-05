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
  if (!isDemo) syncAll().catch(() => {});

  const mcpPort = parseInt(process.env.FUNGIBLE_MCP_PORT ?? '3741', 10);
  const apiPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
  startMcpHttpServer(mcpPort);
  startApiServer(apiPort, { quiet: true });

  render(<App />);
}
