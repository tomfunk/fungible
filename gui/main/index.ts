import { config } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Demo mode must be resolved before core/paths.ts evaluates (it reads
// FUNGIBLE_DATA_DIR at import time), hence the dynamic imports below.
// Same convention as bin/fungible: --demo forces a separate data dir.
if (process.argv.includes('--demo')) process.env.FUNGIBLE_DEMO = '1';
if (process.env.FUNGIBLE_DEMO) {
  process.env.FUNGIBLE_DATA_DIR = join(homedir(), '.fungible-demo');
}

const { DATA_DIR } = await import('../../core/paths.js');

config({ path: join(DATA_DIR, '.env'), quiet: true });

await import('./app.js');
