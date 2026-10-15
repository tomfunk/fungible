import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  snapshot, listSnapshots, listBackups, verifySnapshot, restoreSnapshot, selectDailyKeep,
  resolveSnapshotDir, dailyKeepDays, appVersion, sha256File, type SnapshotEntry,
} from '../core/snapshot.js';
import { registerInUse } from '../core/in-use.js';

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-snaphard-'));
let dir: string;
let client: Client;
let n = 0;
const dbPath = () => path.join(dir, 'fungible.db');
const backups = () => path.join(dir, 'backups');
const at = (iso: string) => new Date(iso);
const opts = (extra: object = {}) => ({ dataDir: dir, client, ...extra });
const noKeyIssue = async () => ({ ok: true });
const posix = process.platform !== 'win32';

beforeEach(async () => {
  dir = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  client = createClient({ url: `file:${dbPath()}` });
  await client.batch([
    'CREATE TABLE tags (name TEXT)',
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)',
    "INSERT INTO tags VALUES ('trip'), ('rent')",
    'PRAGMA user_version = 1',
  ]);
});

afterEach(() => {
  client.close();
  delete process.env.FUNGIBLE_BACKUP_DAYS;
  delete process.env.FUNGIBLE_APP_VERSION;
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const age = (p: string, ms: number) => {
  const d = new Date(Date.now() - ms);
  fs.utimesSync(p, d, d);
};

describe('restore guards', () => {
  it('uses the database own user_version, not a tampered manifest', async () => {
    await client.execute('PRAGMA user_version = 9');
    const snap = await snapshot('manual', opts());
    const mp = path.join(snap.dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.userVersion = 1;
    fs.writeFileSync(mp, JSON.stringify(m));
    expect((await verifySnapshot(snap.dir)).ok).toBe(true); // db sha untouched
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue })).rejects.toThrow(/newer than this build/);
  });

  it('ignores markers of dead pids and of itself, and names live ones', async () => {
    const snap = await snapshot('manual', opts());
    fs.mkdirSync(path.join(dir, '.in-use'));
    fs.writeFileSync(path.join(dir, '.in-use', '2147483000'), ''); // not a live pid
    fs.writeFileSync(path.join(dir, '.in-use', String(process.pid)), '');
    client.close();
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue })).resolves.toBeTruthy();
    expect(fs.existsSync(path.join(dir, '.in-use', '2147483000'))).toBe(false);
    client = createClient({ url: `file:${dbPath()}` });
  });

  it('refuses when a live foreign pid is registered, and --force skips only that check', async () => {
    const snap = await snapshot('manual', opts());
    fs.mkdirSync(path.join(dir, '.in-use'));
    fs.writeFileSync(path.join(dir, '.in-use', String(process.ppid)), '');
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue }))
      .rejects.toThrow(new RegExp(`pid ${process.ppid}.*quit TUI/GUI/MCP first`));

    // force still verifies: a tampered snapshot is refused even with force.
    fs.appendFileSync(path.join(snap.dir, 'fungible.db'), 'x');
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, force: true, keyCheck: noKeyIssue })).rejects.toThrow(/verification/);
  });

  it('a failure between the pre-restore snapshot and the swap leaves the live db untouched', async () => {
    const snap = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    await client.execute("INSERT INTO tags VALUES ('live-only')");
    client.close();
    const before = sha256File(dbPath());
    await expect(restoreSnapshot(snap.dir, {
      dataDir: dir, keyCheck: noKeyIssue, now: at('2026-10-03T12:00:00Z'),
      beforeSwap: () => { throw new Error('boom'); },
    })).rejects.toThrow(/boom/);
    expect(sha256File(dbPath())).toBe(before);
    expect(listSnapshots(dir).some((s) => s.reason === 'pre-restore')).toBe(true);
    client = createClient({ url: `file:${dbPath()}` });
  });

  it('never deletes or overwrites a local key when the snapshot has none', async () => {
    fs.writeFileSync(path.join(dir, 'key'), 'local-key');
    const snap = await snapshot('manual', opts()); // include_key off
    client.close();
    const r = await restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue });
    expect(r.keyRestored).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'key'), 'utf8')).toBe('local-key');
    client = createClient({ url: `file:${dbPath()}` });
  });

  it('opt-in with no key file yields no key entry and no error', async () => {
    const snap = await snapshot('manual', opts({ includeKey: true }));
    expect(snap.manifest.files.map((f) => f.name)).toEqual(['fungible.db']);
  });

  it('prefers backups/<name> over a same-named directory in the cwd', async () => {
    const a = await snapshot('manual', opts({ now: at('2026-10-02T12:00:00Z') }));
    await client.execute("INSERT INTO tags VALUES ('b')");
    const b = await snapshot('manual', opts({ now: at('2026-10-03T12:00:00Z') }));
    const name = path.basename(a.dir);
    const cwdDir = path.join(ROOT, `cwd-${n}`);
    fs.mkdirSync(path.join(cwdDir, name), { recursive: true });
    fs.cpSync(b.dir, path.join(cwdDir, name), { recursive: true });
    const prev = process.cwd();
    process.chdir(cwdDir);
    try {
      expect(resolveSnapshotDir(name, dir)).toBe(a.dir);
    } finally {
      process.chdir(prev);
    }
  });

  it('refuses in a process that already ran initDb unless handed a client to close', async () => {
    const snap = await snapshot('manual', opts());
    registerInUse(dir); // what initDb does; sets the per-process flag
    await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue })).rejects.toThrow(/already has the database open/);
    client.close();
    let closed = 0;
    await restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue, closeClient: () => { closed++; } });
    expect(closed).toBe(1);
    client = createClient({ url: `file:${dbPath()}` });
  });
});

describe('verification depth', () => {
  it('integrity_check catches a corrupt but openable database with a matching checksum', async () => {
    await client.execute('CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)');
    await client.execute('CREATE INDEX big_v ON big(v)');
    await client.batch(Array.from({ length: 400 }, (_, i) => ({
      sql: 'INSERT INTO big (v) VALUES (?)', args: [`value-${i}-${'x'.repeat(40)}`],
    })), 'write');
    const snap = await snapshot('manual', opts());
    const dbf = path.join(snap.dir, 'fungible.db');
    const buf = fs.readFileSync(dbf);
    // Zero out most of a middle page: the file still opens, its structure is wrong.
    const pageSize = buf.readUInt16BE(16) || 65536;
    const page = Math.floor(buf.length / pageSize / 2);
    buf.fill(0xff, page * pageSize + 8, page * pageSize + 400);
    fs.writeFileSync(dbf, buf);
    const mp = path.join(snap.dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.files.find((f: { name: string }) => f.name === 'fungible.db').sha256 = sha256File(dbf);
    fs.writeFileSync(mp, JSON.stringify(m));

    const v = await verifySnapshot(snap.dir);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/integrity_check/);
  });
});

describe('crash residue and intactness', () => {
  it('reaps old .tmp dirs on a daily run and never lists them', async () => {
    fs.mkdirSync(path.join(backups(), '.tmp-1-1'), { recursive: true });
    fs.writeFileSync(path.join(backups(), '.tmp-1-1', 'fungible.db'), 'half');
    age(path.join(backups(), '.tmp-1-1'), 2 * 3_600_000);
    fs.mkdirSync(path.join(backups(), '.tmp-2-2'), { recursive: true }); // fresh: kept
    expect(listBackups(dir)).toEqual([]);

    await snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }));
    expect(fs.existsSync(path.join(backups(), '.tmp-1-1'))).toBe(false);
    expect(fs.existsSync(path.join(backups(), '.tmp-2-2'))).toBe(true);
  });

  it('recovers from a stale lock left by a killed process', async () => {
    fs.mkdirSync(backups(), { recursive: true });
    const lock = path.join(backups(), '.lock');
    fs.writeFileSync(lock, '{"pid":1}');
    age(lock, 10 * 60_000);
    await expect(snapshot('daily', opts({ lockWaitMs: 500 }))).resolves.toBeTruthy();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('at most one build is inside the critical section, even racing a stale lock', async () => {
    fs.mkdirSync(backups(), { recursive: true });
    const lock = path.join(backups(), '.lock');
    fs.writeFileSync(lock, '{"pid":1}');
    age(lock, 10 * 60_000);
    let inside = 0;
    let max = 0;
    const hooks = {
      afterVacuum: async () => {
        inside++;
        max = Math.max(max, inside);
        await new Promise((r) => setTimeout(r, 30));
        inside--;
      },
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => snapshot('manual', opts({ hooks, lockWaitMs: 20_000 }))),
    );
    expect(results).toHaveLength(6);
    expect(max).toBe(1);
    expect(listSnapshots(dir)).toHaveLength(6);
  });

  it('a truncated-but-manifested daily does not suppress a new daily', async () => {
    const first = await snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }));
    fs.truncateSync(path.join(first.dir, 'fungible.db'), 10);
    const second = await snapshot('daily', opts({ now: at('2026-10-02T13:00:00Z') }));
    expect(second.skipped).toBeUndefined();
    expect(second.dir).not.toBe(first.dir);
  });

  it('a truncated daily is not the "newer intact daily" that lets an old named snapshot be pruned', async () => {
    const d = await snapshot('daily', opts({ now: at('2026-10-02T12:00:00Z') }));
    fs.truncateSync(path.join(d.dir, 'fungible.db'), 10);
    await snapshot('pre-enable-sync', opts({ now: at('2026-04-01T12:00:00Z') }));
    await snapshot('manual', opts({ now: at('2026-10-03T12:00:00Z') })); // triggers prune
    expect(listSnapshots(dir).map((s) => s.reason)).toContain('pre-enable-sync');
  });
});

describe('retention and env extras', () => {
  const entry = (date: string, time = '12:00:00'): SnapshotEntry => ({
    kind: 'snapshot', dir: `${date}T${time}`, name: date, created: `${date}T${time}.000Z`, reason: 'daily',
    manifest: {} as never,
  });

  it('parses FUNGIBLE_BACKUP_DAYS: 1, garbage falls back to 7, 0 and -1 disable daily', () => {
    process.env.FUNGIBLE_BACKUP_DAYS = '1';
    expect(dailyKeepDays()).toBe(1);
    process.env.FUNGIBLE_BACKUP_DAYS = 'abc';
    expect(dailyKeepDays()).toBe(7);
    process.env.FUNGIBLE_BACKUP_DAYS = '0';
    expect(dailyKeepDays()).toBe(0);
    process.env.FUNGIBLE_BACKUP_DAYS = '-1';
    expect(dailyKeepDays()).toBeLessThanOrEqual(0);
  });

  it('with FUNGIBLE_BACKUP_DAYS=1 keeps only today plus the Sunday/month picks', () => {
    // 2026-10-04 is a Sunday.
    const kept = [...selectDailyKeep(
      [entry('2026-10-02'), entry('2026-10-03'), entry('2026-10-04'), entry('2026-10-05')], 1,
    )].sort();
    expect(kept).toEqual(['2026-10-02T12:00:00', '2026-10-04T12:00:00', '2026-10-05T12:00:00']);
  });

  it('handles a Sunday across a month and year boundary', () => {
    // 2026-12-27 and 2027-01-03 are Sundays.
    const kept = [...selectDailyKeep(
      [entry('2026-12-27'), entry('2026-12-31'), entry('2027-01-03'), entry('2027-01-04')], 1,
    )].sort();
    expect(kept).toEqual(['2026-12-27T12:00:00', '2027-01-03T12:00:00', '2027-01-04T12:00:00']);
  });

  it('keeps only the newest of two dailies on the same UTC day', () => {
    const kept = [...selectDailyKeep([entry('2026-10-02', '08:00:00'), entry('2026-10-02', '20:00:00')], 7)];
    expect(kept).toEqual(['2026-10-02T20:00:00']);
  });

  it('treats reason "daily-x" as a named snapshot, distinct from "daily"', async () => {
    const now = at('2026-10-02T12:00:00Z');
    await snapshot('daily', opts({ now }));
    const x1 = await snapshot('daily-x', opts({ now }));
    const x2 = await snapshot('daily-x', opts({ now }));
    expect(x1.skipped).toBeUndefined();
    expect(x2.dir).not.toBe(x1.dir);
    expect(listSnapshots(dir).filter((s) => s.reason === 'daily')).toHaveLength(1);
  });

  it.skipIf(!posix)('key copy stays 0600 even when the source is world readable', async () => {
    fs.writeFileSync(path.join(dir, 'key'), 'k', { mode: 0o644 });
    const s = await snapshot('manual', opts({ includeKey: true }));
    expect(fs.statSync(path.join(s.dir, 'key')).mode & 0o777).toBe(0o600);
  });
});

describe('appVersion', () => {
  it('resolves a real version when run from source', () => {
    expect(appVersion()).not.toBe('unknown');
  });

  it('honours FUNGIBLE_APP_VERSION', () => {
    process.env.FUNGIBLE_APP_VERSION = '1.2.3-test';
    expect(appVersion()).toBe('1.2.3-test');
  });

  it('walks up from a bundled output dir to package.json and VERSION', () => {
    const root = path.join(ROOT, `tree-${n}`);
    const deep = path.join(root, 'out', 'main');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fungible","version":"4.5.6"}');
    expect(appVersion([deep])).toBe('4.5.6');
    fs.writeFileSync(path.join(root, 'VERSION'), '$Format:%(describe:tags)$');
    expect(appVersion([deep])).toBe('4.5.6'); // placeholder ignored
    fs.writeFileSync(path.join(root, 'VERSION'), 'v7.8.9\n');
    expect(appVersion([deep])).toBe('7.8.9');
  });

  it('falls back to "unknown" when nothing is found', () => {
    const lone = path.join(ROOT, `lone-${n}`);
    fs.mkdirSync(lone, { recursive: true });
    fs.writeFileSync(path.join(lone, 'package.json'), '{"name":"other","version":"1.0.0"}');
    expect(appVersion([lone])).toBe('unknown');
  });
});
