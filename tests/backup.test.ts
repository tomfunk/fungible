import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

// vi.hoisted runs before vi.mock factories, giving us a temp dir that backup.ts
// can pick up when it computes its module-level DB_PATH and BACKUP_DIR constants.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-backup-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { backupDb } from '../core/backup.js';

const BACKUP_DIR = path.join(TEST_DATA_DIR, 'backups');
const TODAY = new Date().toISOString().slice(0, 10);
const BACKUP_PATH = path.join(BACKUP_DIR, `fungible.${TODAY}.bak`);

beforeEach(async () => {
  // Fake db file on disk so the existsSync guard passes
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'fungible.db'), '');
  // Reset backup dir and in-memory data between tests
  if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true });
  await db.execute('DELETE FROM tags');
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('backupDb', () => {
  it('creates a single backup file containing data written to the db', async () => {
    await db.execute("INSERT INTO tags (name) VALUES ('brussels-trip')");

    await backupDb();

    expect(fs.existsSync(BACKUP_PATH)).toBe(true);
    const backup = createClient({ url: `file:${BACKUP_PATH}` });
    const { rows } = await backup.execute('SELECT name FROM tags');
    expect(rows.map((r) => r.name)).toContain('brussels-trip');
  });

  it('does not overwrite an existing backup for today', async () => {
    await backupDb();
    const sizeBefore = fs.statSync(BACKUP_PATH).size;

    await db.execute("INSERT INTO tags (name) VALUES ('extra-tag')");
    await backupDb();

    expect(fs.statSync(BACKUP_PATH).size).toBe(sizeBefore);
  });

  it('rotates backups older than keepDays', async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      fs.writeFileSync(path.join(BACKUP_DIR, `fungible.${d}.bak`), '');
    }

    process.env.FUNGIBLE_BACKUP_DAYS = '2';
    try {
      await backupDb();
    } finally {
      delete process.env.FUNGIBLE_BACKUP_DAYS;
    }

    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.bak'));
    // keepDays=2: today + 2026-01-03 kept; 2026-01-01 and 2026-01-02 rotated out
    expect(files).not.toContain('fungible.2026-01-01.bak');
    expect(files).not.toContain('fungible.2026-01-02.bak');
    expect(files).toContain('fungible.2026-01-03.bak');
    expect(files).toContain(`fungible.${TODAY}.bak`);
  });

  it('skips backup when FUNGIBLE_BACKUP_DAYS is 0', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '0';
    try {
      await backupDb();
    } finally {
      delete process.env.FUNGIBLE_BACKUP_DAYS;
    }

    expect(fs.existsSync(BACKUP_PATH)).toBe(false);
  });
});
