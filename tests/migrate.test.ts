import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';

// The module under test defaults to the shared app client; every test passes
// its own temp-dir client, so keep core/db.js (and ~/.fungible) out of it.
vi.mock('../core/db.js', () => ({ db: {} }));

import { migrate, appliedVersions, getDeviceId, MigrateError, DEVICE_ID_KEY } from '../core/migrate.js';
import { listSnapshots } from '../core/snapshot.js';
import { SCHEMA_USER_VERSION } from '../core/schema-version.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-migrate-'));
let dir: string;
let client: Client;
let n = 0;

beforeEach(async () => {
  dir = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  client = createClient({ url: `file:${path.join(dir, 'fungible.db')}` });
  await client.batch([
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
    "INSERT INTO tags (name) VALUES ('trip')",
    'PRAGMA user_version = 1',
  ]);
});
afterEach(() => client.close());
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const cols = async () =>
  ((await client.execute('PRAGMA table_info(tags)')).rows as unknown as { name: string }[]).map((r) => r.name);

describe('migrate', () => {
  it('snapshots first, runs the statements atomically with the record, and is idempotent', async () => {
    let runs = 0;
    const body = () => { runs++; return ['ALTER TABLE tags ADD COLUMN uuid TEXT']; };

    const r = await migrate(2, 'add-uuid', body, { client, dataDir: dir });
    expect(r).toEqual({ applied: true, version: 2 });
    expect(await cols()).toContain('uuid');
    expect(await appliedVersions(client)).toEqual([2]);
    expect(listSnapshots(dir).map((s) => s.manifest.reason)).toEqual(['pre-migrate-2']);
    const uv = await client.execute('PRAGMA user_version');
    expect(Number((uv.rows[0] as unknown as { user_version: number }).user_version)).toBe(2);

    const again = await migrate(2, 'add-uuid', body, { client, dataDir: dir });
    expect(again.applied).toBe(false);
    expect(runs).toBe(1);
    expect(listSnapshots(dir)).toHaveLength(1);
  });

  it('fails closed: a failing snapshot leaves the database untouched and runs nothing', async () => {
    let ran = false;
    await expect(
      migrate(2, 'x', () => { ran = true; return ['ALTER TABLE tags ADD COLUMN uuid TEXT']; }, {
        client,
        snapshot: async () => { throw new Error('disk full'); },
      }),
    ).rejects.toMatchObject({ name: 'MigrateError', code: 'snapshot_failed' });
    expect(ran).toBe(false);
    expect(await cols()).not.toContain('uuid');
    const tbl = await client.execute("SELECT 1 FROM sqlite_master WHERE name = '_migrations'");
    expect(tbl.rows).toHaveLength(0);
  });

  it('rolls back every statement when one fails, and records nothing', async () => {
    await expect(
      migrate(2, 'bad', () => ['ALTER TABLE tags ADD COLUMN uuid TEXT', 'ALTER TABLE nope ADD COLUMN y TEXT'], { client, snapshot: false }),
    ).rejects.toBeInstanceOf(MigrateError);
    expect(await cols()).not.toContain('uuid');
    expect(await appliedVersions(client)).toEqual([]);
  });

  it('refuses a version newer than the build knows', async () => {
    await expect(migrate(SCHEMA_USER_VERSION + 1, 'future', () => [], { client, snapshot: false }))
      .rejects.toMatchObject({ code: 'unknown_version' });
  });
});

describe('getDeviceId', () => {
  it('is generated once, stable, and stored as a non-synced setting', async () => {
    const a = await getDeviceId(client);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getDeviceId(client)).toBe(a);
    const row = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [DEVICE_ID_KEY] });
    expect((row.rows[0] as unknown as { value: string }).value).toBe(a);
  });
});
