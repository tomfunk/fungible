/**
 * Throwaway data dir for tests that exercise code writing under DATA_DIR
 * (core/env-file.ts, backups, canvas history, the GUI registry's config.writeEnv).
 *
 * core/paths.ts exports only DATA_DIR, so mocking it is sufficient to keep a
 * test off the real ~/.fungible. Usage (vi.mock is hoisted, so import lazily):
 *
 *   vi.mock('../../core/paths.js', async () => ({
 *     DATA_DIR: (await import('../helpers/tempDataDir.js')).tempDataDir.dir,
 *   }));
 *   import { tempDataDir } from '../helpers/tempDataDir.js';
 *   beforeEach(() => tempDataDir.reset());
 *   afterAll(() => tempDataDir.cleanup());
 *
 * The directory is a fresh os.tmpdir() mkdtemp, created at import time, and
 * the helper refuses to operate on anything outside the OS temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-test-data-'));

function assertSafe(): void {
  const real = path.resolve(dir);
  const tmp = fs.realpathSync(os.tmpdir());
  const home = path.join(os.homedir(), '.fungible');
  if (!real.startsWith(tmp + path.sep) || real === home || real.startsWith(home + path.sep)) {
    throw new Error(`tempDataDir refuses unsafe path: ${real}`);
  }
}
assertSafe();

export const tempDataDir = {
  /** Absolute path of the temp data dir. */
  dir,
  /** Where core/env-file.ts reads and writes. */
  envPath: path.join(dir, '.env'),
  /** Raw contents of the temp .env, or '' when absent. */
  readEnv(): string {
    return fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '';
  },
  /** Empty the directory (keeps the dir itself). Call in beforeEach. */
  reset(): void {
    assertSafe();
    fs.mkdirSync(dir, { recursive: true });
    for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  },
  /** Remove the directory entirely. Call in afterAll. */
  cleanup(): void {
    assertSafe();
    fs.rmSync(dir, { recursive: true, force: true });
  },
};
