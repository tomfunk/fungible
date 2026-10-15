import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  snapshot, listSnapshots, listBackups, verifySnapshot, restoreSnapshot, selectDailyKeep,
  getBackupStatus, recordLastRun, sha256File, type SnapshotEntry,
} from '../core/snapshot.js';
import { SCHEMA_USER_VERSION } from '../core/schema-version.js';
import { run } from '../scripts/backup.js';

// Every test works in its own mkdtemp dir under the OS temp dir; nothing here
// touches ~/.fungible and core/db.js (the shared client) is never imported.
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-snapshot-'));
if (!ROOT.startsWith(fs.realpathSync(os.tmpdir()))) throw new Error('unsafe test dir');

let dir: string;
let client: Client;
let n = 0;

const dbPath = () => path.join(dir, 'fungible.db');
const backups = () => path.join(dir, 'backups');
const at = (iso: string) => new Date(iso);

beforeEach(async () => {
  dir = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  client = createClient({ url: `file:${dbPath()}` });
  await client.batch([
    'CREATE TABLE tags (name TEXT)',
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)',
    "INSERT INTO tags VALUES ('trip'), ('rent')",
    `PRAGMA user_version = ${SCHEMA_USER_VERSION}`,
  ]);
});

afterEach(() => {
  client.close();
  delete process.env.FUNGIBLE_BACKUP_DAYS;
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const opts = (extra: object = {}) => ({ dataDir: dir, client, ...extra });
const names = () => (fs.existsSync(backups()) ? fs.readdirSync(backups()) : []);

describe('snapshot creation', () => {
  it('writes a verified snapshot with a manifest that matches the files', async () => {
    fs.writeFileSync(path.join(dir, 'canvas-history.json'), '[{"id":"1"}]');
    const r = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));

    expect(path.basename(r.dir)).toBe('2026-10-02T120000-manual');
    expect(r.manifest.reason).toBe('manual');
    expect(r.manifest.userVersion).toBe(SCHEMA_USER_VERSION);
    expect(r.manifest.rowCounts.tags).toBe(2);
    expect(r.manifest.files.map((f) => f.name).sort()).toEqual(['canvas-history.json', 'fungible.db']);
    for (const f of r.manifest.files) {
      expect(f.sha256).toBe(sha256File(path.join(r.dir, f.name)));
      expect(f.bytes).toBe(fs.statSync(path.join(r.dir, f.name)).size);
    }
    expect((await verifySnapshot(r.dir)).ok).toBe(true);

    const copy = createClient({ url: `file:${path.join(r.dir, 'fungible.db')}` });
    expect((await copy.execute('SELECT name FROM tags ORDER BY name')).rows.map((x) => x.name)).toEqual(['rent', 'trip']);
    copy.close();
    expect(names().filter((x) => x.startsWith('.tmp'))).toEqual([]);
  });

  it('leaves no final dir or temp dir when the build fails after VACUUM INTO', async () => {
    await expect(snapshot('manual', opts({
      hooks: { afterVacuum: () => { throw new Error('disk full'); } },
    }))).rejects.toThrow(/disk full/);
    expect(names()).toEqual([]); // not even a stale lock

    // And a later attempt works: nothing was left wedged.
    expect((await snapshot('manual', opts())).dir).toBeTruthy();
  });

  it('refuses a copy that fails quick_check and leaves nothing behind', async () => {
    await expect(snapshot('manual', opts({
      hooks: { afterVacuum: (p: string) => fs.writeFileSync(p, Buffer.alloc(4096, 0x41)) },
    }))).rejects.toThrow(/integrity|not a database|failed/i);
    expect(names()).toEqual([]);
  });

  it('daily skips when a daily for today exists; named always takes a fresh copy', async () => {
    const now = at('2026-10-02T12:00:00Z');
    const a = await snapshot('daily', opts({ now }));
    await client.execute("INSERT INTO tags VALUES ('later')");
    const b = await snapshot('daily', opts({ now: at('2026-10-02T18:00:00Z') }));
    expect(b.skipped).toBe(true);
    expect(b.dir).toBe(a.dir);
    expect(b.manifest.rowCounts.tags).toBe(2);

    const c = await snapshot('pre-enable-sync', opts({ now }));
    const d = await snapshot('pre-enable-sync', opts({ now }));
    expect(c.manifest.rowCounts.tags).toBe(3);
    expect(d.dir).not.toBe(c.dir);
    expect(listSnapshots(dir)).toHaveLength(3);
  });

  it('concurrent daily callers produce exactly one snapshot', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }))),
    );
    expect(new Set(results.map((r) => r.dir)).size).toBe(1);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(listSnapshots(dir)).toHaveLength(1);
    expect(fs.existsSync(path.join(backups(), '.lock'))).toBe(false);
  });

  it('takes over a stale lock but waits out a fresh one', async () => {
    fs.mkdirSync(backups(), { recursive: true });
    const lock = path.join(backups(), '.lock');
    fs.writeFileSync(lock, '{}');
    await expect(snapshot('manual', opts({ lockWaitMs: 150 }))).rejects.toThrow(/in progress/);

    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    await expect(snapshot('manual', opts({ lockWaitMs: 150 }))).resolves.toBeTruthy();
  });

  it.skipIf(process.platform === 'win32')('includes the key only when opted in, with mode 0600, and never .env', async () => {
    fs.writeFileSync(path.join(dir, 'key'), 'base64key', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-secret');

    const off = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    expect(fs.readdirSync(off.dir).sort()).toEqual(['fungible.db', 'manifest.json']);

    await client.execute("INSERT INTO settings VALUES ('backup_include_key', 'true')");
    const on = await snapshot('manual', opts({ now: at('2026-10-02T12:00:05Z') }));
    expect(fs.readdirSync(on.dir).sort()).toEqual(['fungible.db', 'key', 'manifest.json']);
    expect(fs.statSync(path.join(on.dir, 'key')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(on.dir, 'key'), 'utf8')).toBe('base64key');
    expect(fs.existsSync(path.join(on.dir, '.env'))).toBe(false);
  });

  it('does nothing and throws a clear error when there is no database', async () => {
    fs.rmSync(dbPath());
    await expect(snapshot('manual', opts())).rejects.toThrow(/no database/);
  });
});

describe('verification', () => {
  it('detects a modified file', async () => {
    fs.writeFileSync(path.join(dir, 'canvas-history.json'), '[]');
    const r = await snapshot('manual', opts());
    fs.writeFileSync(path.join(r.dir, 'canvas-history.json'), '[1]');
    const v = await verifySnapshot(r.dir);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/canvas-history.json: sha256 mismatch/);
  });
});

describe('retention', () => {
  const entry = (date: string): SnapshotEntry => ({
    kind: 'snapshot', dir: date, name: date, created: `${date}T12:00:00.000Z`, reason: 'daily',
    manifest: {} as never,
  });

  it('keeps newest 7 days, 4 Sundays and the earliest of 3 months', () => {
    const all: SnapshotEntry[] = [];
    for (let t = Date.UTC(2026, 6, 1); t <= Date.UTC(2026, 9, 1); t += 86_400_000) {
      all.push(entry(new Date(t).toISOString().slice(0, 10)));
    }
    const kept = [...selectDailyKeep(all, 7)].sort();
    expect(kept).toEqual([
      '2026-08-01', '2026-09-01', '2026-09-06', '2026-09-13', '2026-09-20',
      '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01',
    ]);
  });

  it('prunes old dailies on disk by manifest timestamp, not filename', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '2';
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      await snapshot('daily', opts({ now: at(`${d}T12:00:00Z`) }));
    }
    const left = listSnapshots(dir).map((s) => s.created.slice(0, 10));
    // 2 newest days, plus the earliest of the month (stable monthly pick).
    expect(left).toEqual(['2026-10-01', '2026-10-03', '2026-10-04']);
  });

  it('exempts named snapshots from count pruning and age-prunes them only behind a newer daily', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '2';
    await snapshot('pre-enable-sync', opts({ now: at('2026-04-01T12:00:00Z') }));
    await snapshot('manual', opts({ now: at('2026-09-20T12:00:00Z') }));
    // Many dailies later, named snapshots are not touched by the count rule.
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      await snapshot('daily', opts({ now: at(`${d}T12:00:00Z`) }));
    }
    const reasons = listSnapshots(dir).map((s) => `${s.created.slice(0, 10)}:${s.reason}`);
    expect(reasons).toContain('2026-09-20:manual');
    // >90 days old AND a newer verified daily exists: pruned.
    expect(reasons).not.toContain('2026-04-01:pre-enable-sync');
  });

  it('keeps an old named snapshot when no newer daily exists', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '2';
    await snapshot('pre-enable-sync', opts({ now: at('2026-04-01T12:00:00Z') }));
    await snapshot('manual', opts({ now: at('2026-10-04T12:00:00Z') }));
    expect(listSnapshots(dir).map((s) => s.reason).sort()).toEqual(['manual', 'pre-enable-sync']);
  });

  it('lists legacy .bak files and leaves them alone for named snapshots', async () => {
    fs.mkdirSync(backups(), { recursive: true });
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      fs.writeFileSync(path.join(backups(), `fungible.${d}.bak`), 'x');
    }
    await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    expect(names().filter((x) => x.endsWith('.bak'))).toHaveLength(3);
    const kinds = listBackups(dir).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'legacy')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'snapshot')).toHaveLength(1);
  });

  it('prunes legacy files with the old keep-N rule on a daily run', async () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '2';
    fs.mkdirSync(backups(), { recursive: true });
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      fs.writeFileSync(path.join(backups(), `fungible.${d}.bak`), 'x');
    }
    await snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }));
    expect(names().filter((x) => x.endsWith('.bak')).sort())
      .toEqual(['fungible.2026-01-02.bak', 'fungible.2026-01-03.bak']);
  });
});

describe('restore', () => {
  const noKeyIssue = async () => ({ ok: true });

  it('round-trips data and takes a pre-restore snapshot of the current state', async () => {
    const snap = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    await client.execute("INSERT INTO tags VALUES ('after-snapshot')");
    client.close();

    const r = await restoreSnapshot(snap.dir, { dataDir: dir, now: at('2026-10-03T12:00:00Z'), keyCheck: noKeyIssue });
    expect(r.restoredFrom).toBe(snap.dir);
    expect(path.basename(r.preRestoreDir)).toMatch(/-pre-restore$/);

    const live = createClient({ url: `file:${dbPath()}` });
    expect((await live.execute('SELECT COUNT(*) AS n FROM tags')).rows[0].n).toBe(2);
    live.close();
    const pre = createClient({ url: `file:${path.join(r.preRestoreDir, 'fungible.db')}` });
    expect((await pre.execute('SELECT COUNT(*) AS n FROM tags')).rows[0].n).toBe(3);
    pre.close();
    client = createClient({ url: `file:${dbPath()}` });
  });

  it('restores "latest" and the canvas history file', async () => {
    fs.writeFileSync(path.join(dir, 'canvas-history.json'), '[{"id":"old"}]');
    await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    fs.writeFileSync(path.join(dir, 'canvas-history.json'), '[{"id":"new"}]');
    const r = await restoreSnapshot('latest', { dataDir: dir, keyCheck: noKeyIssue });
    expect(r.canvasRestored).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'canvas-history.json'), 'utf8')).toBe('[{"id":"old"}]');
  });

  it('refuses a snapshot from a newer schema and changes nothing', async () => {
    await client.execute(`PRAGMA user_version = ${SCHEMA_USER_VERSION + 4}`);
    const snap = await snapshot('manual', opts());
    expect(snap.manifest.userVersion).toBe(SCHEMA_USER_VERSION + 4);
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue })).rejects.toThrow(/newer than this build/);
    expect(listSnapshots(dir).some((s) => s.reason === 'pre-restore')).toBe(false);
  });

  it('refuses a snapshot that fails verification', async () => {
    const snap = await snapshot('manual', opts());
    fs.appendFileSync(path.join(snap.dir, 'fungible.db'), 'garbage');
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue })).rejects.toThrow(/verification/);
  });

  it('refuses while another connection holds the database, leaving it untouched', async () => {
    const snap = await snapshot('manual', opts());
    await client.execute("INSERT INTO tags VALUES ('live-edit')");
    const other = createClient({ url: `file:${dbPath()}` });
    await other.execute('BEGIN IMMEDIATE');
    try {
      await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue }))
        .rejects.toThrow(/quit TUI\/GUI\/MCP first/);
    } finally {
      await other.execute('ROLLBACK');
      other.close();
    }
    expect((await client.execute('SELECT COUNT(*) AS n FROM tags')).rows[0].n).toBe(3);
  });

  it('surfaces the key-health warning after restore', async () => {
    const snap = await snapshot('manual', opts());
    const r = await restoreSnapshot(snap.dir, {
      dataDir: dir,
      keyCheck: async () => ({ ok: false, reason: 'missing_key', linkedAccountCount: 2 }),
    });
    expect(r.warnings.join('\n')).toMatch(/WARNING.*missing_key.*2 linked account/s);
  });

  it('restores an included key (0600) and keeps a differing local key aside', async () => {
    fs.writeFileSync(path.join(dir, 'key'), 'snapshot-key');
    const snap = await snapshot('manual', opts({ includeKey: true }));
    fs.writeFileSync(path.join(dir, 'key'), 'different-key');
    const r = await restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue });
    expect(r.keyRestored).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'key'), 'utf8')).toBe('snapshot-key');
    expect(fs.statSync(path.join(dir, 'key')).mode & 0o777).toBe(0o600);
    const aside = fs.readdirSync(dir).find((f) => f.startsWith('key.replaced-'))!;
    expect(fs.readFileSync(path.join(dir, aside), 'utf8')).toBe('different-key');
  });
});

describe('status', () => {
  it('reports last error, last success, count and newest dir', async () => {
    expect(getBackupStatus(dir)).toMatchObject({ lastSuccessAt: null, lastError: null, count: 0, newestDir: null });
    const r = await snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }));
    recordLastRun(dir, { at: '2026-10-02T12:00:00.000Z', ok: true, reason: 'daily', dir: r.dir });
    recordLastRun(dir, { at: '2026-10-03T12:00:00.000Z', ok: false, reason: 'daily', error: 'disk full' });
    expect(getBackupStatus(dir)).toMatchObject({
      lastSuccessAt: '2026-10-02T12:00:00.000Z', lastError: 'disk full', count: 1, newestDir: r.dir,
    });
  });
});

describe('CLI entry points', () => {
  function ctx(extra: object = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, c: { dataDir: dir, client, out: (s: string) => out.push(s), err: (s: string) => err.push(s), ...extra } };
  }

  it('backup, list --json, verify and restore work end to end with exit codes', async () => {
    const a = ctx();
    expect(await run(['backup', '--reason', 'before upgrade'], a.c)).toBe(0);
    expect(a.out[0]).toMatch(/Backup created: .*before-upgrade$/);

    const l = ctx();
    expect(await run(['backup', 'list', '--json'], l.c)).toBe(0);
    const parsed = JSON.parse(l.out.join('\n'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: 'snapshot', reason: 'before-upgrade' });

    expect(await run(['backup', 'verify', 'latest'], ctx().c)).toBe(0);

    const dirName = parsed[0].dir as string;
    fs.appendFileSync(path.join(dirName, 'fungible.db'), 'x');
    const bad = ctx();
    expect(await run(['backup', 'verify', 'latest'], bad.c)).toBe(1);
    expect(bad.err.join('\n')).toMatch(/FAILED/);
    expect(await run(['restore', 'latest'], ctx().c)).toBe(1);
  });

  it('exits non-zero with usage on bad arguments and with a message on failure', async () => {
    expect(await run(['backup', 'bogus'], ctx().c)).toBe(1);
    expect(await run(['restore'], ctx().c)).toBe(1);
    const f = ctx();
    fs.rmSync(dbPath());
    expect(await run(['backup'], f.c)).toBe(1);
    expect(f.err.join()).toMatch(/no database/);
  });

  it('verify accepts an explicit snapshot path', async () => {
    const snap = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    client.close();
    const r = ctx({ client: undefined });
    // keyCheck falls back to core/key-health against the shared db; with no linked
    // accounts in a fresh temp dir that import would open ~/.fungible, so run only
    // the verify+list surface here and cover restore through restoreSnapshot above.
    expect(await run(['backup', 'verify', snap.dir], r.c)).toBe(0);
    client = createClient({ url: `file:${dbPath()}` });
  });
});
