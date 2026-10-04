import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/paths.js', async () => ({
  DATA_DIR: (await import('./tempDataDir.js')).tempDataDir.dir,
}));

import { tempDataDir } from './tempDataDir.js';
import { DATA_DIR } from '../../core/paths.js';
import { writeEnvFile, readEnvFile } from '../../core/env-file.js';
import { deferred } from './deferred.js';

const realHome = path.join(os.homedir(), '.fungible');

beforeEach(() => tempDataDir.reset());
afterAll(() => tempDataDir.cleanup());

describe('tempDataDir', () => {
  it('lives under the OS temp dir, never the real data dir', () => {
    expect(DATA_DIR).toBe(tempDataDir.dir);
    expect(tempDataDir.dir.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(tempDataDir.dir.startsWith(realHome)).toBe(false);
  });

  it('routes core/env-file.ts writes to the temp dir only', () => {
    const realEnv = path.join(realHome, '.env');
    const before = fs.existsSync(realEnv) ? fs.statSync(realEnv).mtimeMs : null;
    const { written, path: p } = writeEnvFile({ PLAID_CLIENT_ID: 'abc' });
    expect(written).toEqual(['PLAID_CLIENT_ID']);
    expect(p).toBe(tempDataDir.envPath);
    expect(tempDataDir.readEnv()).toBe('PLAID_CLIENT_ID=abc\n');
    expect(readEnvFile()).toEqual({ PLAID_CLIENT_ID: 'abc' });
    const after = fs.existsSync(realEnv) ? fs.statSync(realEnv).mtimeMs : null;
    expect(after).toBe(before);
  });

  it('reset empties the dir and readEnv returns empty string', () => {
    writeEnvFile({ A_KEY: 'x' });
    tempDataDir.reset();
    expect(fs.readdirSync(tempDataDir.dir)).toEqual([]);
    expect(tempDataDir.readEnv()).toBe('');
  });
});

describe('deferred', () => {
  it('resolves and rejects from outside', async () => {
    const d = deferred<number>();
    let settled = false;
    void d.promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    d.resolve(7);
    await expect(d.promise).resolves.toBe(7);
    const r = deferred();
    r.reject(new Error('boom'));
    await expect(r.promise).rejects.toThrow('boom');
  });
});
