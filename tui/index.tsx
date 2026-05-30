import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env'), quiet: true });
import React from 'react';
import { render } from 'ink';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { syncAll } from '../core/sync.js';
import { rebuildDisplayNames } from '../core/rename.js';
import { App } from './App.js';
import { Setup } from './Setup.js';

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
  render(<App />);
}
