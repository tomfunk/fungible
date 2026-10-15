import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

// vi.hoisted runs before vi.mock factories, giving us a temp dir that backup.ts
// can pick up as DATA_DIR.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-backup-'));
  return { TEST_DATA_DIR: dir };
});

vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { backupDb, getBackupStatus } from '../core/backup.js';
import { snapshot, listSnapshots } from '../core/snapshot.js';
import { setSetting, BACKUP_INCLUDE_KEY_KEY } from '../core/settings.js';

const BACKUP_DIR = path.join(TEST_DATA_DIR, 'backups');

beforeEach(async () => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  for (const e of fs.readdirSync(TEST_DATA_DIR)) fs.rmSync(path.join(TEST_DATA_DIR, e), { recursive: true, force: true });
  // backupDb only checks the file exists; the data comes from the (mocked) client.
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'fungible.db'), '');
  await db.execute('DELETE FROM tags');
  await db.execute('DELETE FROM settings');
});

afterEach(() => {
  delete process.env.FUNGIBLE_BACKUP_DAYS;
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('backupDb', () => {
  it('writes one verified daily snapshot containing the data and records success', async () => {
    await db.execute("INSERT INTO tags (name) VALUES ('brussels-trip')");

    await backupDb();

    const snaps = listSnapshots(TEST_DATA_DIR);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].reason).toBe('daily');
    const copy = createClient({ url: `file:${path.join(snaps[0].dir, 'fungible.db')}` });
    const { rows } = await copy.execute('SELECT name FROM tags');
    copy.close();
    expect(rows.map((r) => r.name)).toContain('brussels-trip');

    const status = getBackupStatus(TEST_DATA_DIR);
    expect(status).toMatchObject({ lastError: null, count: 1, newestDir: snaps[0].dir });
    expect(status.lastSuccessAt).toBeTruthy();
  });

  it('does not take a second snapshot on the same day', async () => {
    await backupDb();
    await db.execute("INSERT INTO tags (name) VALUES ('extra-tag')");
    await backupDb();
    expect(listSnapshots(TEST_DATA_DIR)).toHaveLength(1);
  });

  it('does not throw on failure; records the error and logs it once', async () => {
    const real = db.execute.bind(db);
    vi.spyOn(db, 'execute').mockImplementation(((q: unknown) => {
      if (typeof q === 'object' && q && 'sql' in q && String((q as { sql: string }).sql).startsWith('VACUUM')) {
        return Promise.reject(new Error('disk full'));
      }
      return real(q as never);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(backupDb()).resolves.toBeUndefined();
    await backupDb();

    expect(getBackupStatus(TEST_DATA_DIR).lastError).toMatch(/disk full/);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(listSnapshots(TEST_DATA_DIR)).toHaveLength(0);
  });

  it('skips daily snapshots when FUNGIBLE_BACKUP_DAYS <= 0 but named ones still work', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '0';
    await backupDb();
    expect(fs.existsSync(BACKUP_DIR)).toBe(false);

    const r = await snapshot('manual', { dataDir: TEST_DATA_DIR });
    expect(fs.existsSync(path.join(r.dir, 'fungible.db'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('includes the key only when backup_include_key is on, with mode 0600', async () => {
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'key'), 'dummy-key-material');
    await backupDb();
    expect(fs.existsSync(path.join(listSnapshots(TEST_DATA_DIR)[0].dir, 'key'))).toBe(false);

    fs.rmSync(BACKUP_DIR, { recursive: true });
    await setSetting(BACKUP_INCLUDE_KEY_KEY, 'true');
    await backupDb();
    const keyCopy = path.join(listSnapshots(TEST_DATA_DIR)[0].dir, 'key');
    expect(fs.readFileSync(keyCopy, 'utf8')).toBe('dummy-key-material');
    expect(fs.statSync(keyCopy).mode & 0o777).toBe(0o600);
  });

  it('copies canvas-history.json into the snapshot', async () => {
    fs.writeFileSync(path.join(TEST_DATA_DIR, 'canvas-history.json'), '[{"id":"1","title":"trip"}]');
    await backupDb();
    const copy = path.join(listSnapshots(TEST_DATA_DIR)[0].dir, 'canvas-history.json');
    expect(fs.readFileSync(copy, 'utf8')).toBe('[{"id":"1","title":"trip"}]');
  });
});
