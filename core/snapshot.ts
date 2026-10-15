/**
 * Verified, atomic, whole-state snapshots of the local data dir (Node-only).
 *
 * Layout: <dataDir>/backups/<YYYY-MM-DDTHHMMSS>-<reason>/
 *   fungible.db           VACUUM INTO copy, PRAGMA quick_check verified
 *   canvas-history.json   if present
 *   key                   ONLY when the backup_include_key setting is 'true'
 *   manifest.json         created, reason, appVersion, userVersion, rowCounts, files+sha256
 *
 * "key" is the local encryption key file used to encrypt Plaid tokens. It is
 * not an API key. .env (API keys) is never copied. Backups live next to the
 * database, so they do NOT protect against loss of the disk; there is no
 * off-machine upload here by design.
 *
 * A snapshot is built in backups/.tmp-<pid>-<ts>/ and renamed into place only
 * after verification, so a crash can never leave a half snapshot under a final
 * name. Legacy fungible.<date>.bak files from older builds are left alone,
 * listed as legacy entries and pruned only by the old keep-N-files rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { DATA_DIR } from './paths.js';
import { SCHEMA_USER_VERSION } from './schema-version.js';
import { dbInitializedInProcess, liveInUsePids } from './in-use.js';

const BACKUP_INCLUDE_KEY_SETTING = 'backup_include_key';
const LOCK_STALE_MS = 2 * 60_000;
const NAMED_RETENTION_DAYS = 90;
const DAILY_DAYS_DEFAULT = 7;
const WEEKLY_KEEP = 4;
const MONTHLY_KEEP = 3;
const DAY_MS = 86_400_000;

export interface ManifestFile { name: string; bytes: number; sha256: string }
export interface SnapshotManifest {
  format: 1;
  created: string;
  reason: string;
  appVersion: string;
  userVersion: number;
  rowCounts: Record<string, number>;
  files: ManifestFile[];
}

export interface SnapshotHooks {
  /** Test seam: runs after VACUUM INTO, before verification. May throw or corrupt the file. */
  afterVacuum?: (tmpDbPath: string) => void | Promise<void>;
}

export interface SnapshotOptions {
  dataDir?: string;
  /** Client for the live database. Defaults to core/db.js's shared client. */
  client?: Client;
  now?: Date;
  /** Overrides the backup_include_key setting. */
  includeKey?: boolean;
  /** Max time to wait for another process's snapshot to finish. */
  lockWaitMs?: number;
  hooks?: SnapshotHooks;
}

export class SnapshotError extends Error {}

interface Paths { dataDir: string; db: string; backups: string; key: string; canvas: string; lock: string; lastRun: string }

function pathsFor(dataDir: string = DATA_DIR): Paths {
  const backups = path.join(dataDir, 'backups');
  return {
    dataDir,
    db: path.join(dataDir, 'fungible.db'),
    backups,
    key: path.join(dataDir, 'key'),
    canvas: path.join(dataDir, 'canvas-history.json'),
    lock: path.join(backups, '.lock'),
    lastRun: path.join(backups, 'last-run.json'),
  };
}

// performance clock is not touched by fake-Date test clocks; used for lock staleness only.
const wallMs = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * App version for manifests. Order: FUNGIBLE_APP_VERSION env override, then
 * walk up from the module location, the app resources dir and process.cwd()
 * to the nearest VERSION file (skipping the export-subst placeholder) or
 * package.json named "fungible". Bundled builds (GUI main lives in out/) are
 * covered by the walk-up. Falls back to 'unknown' and never throws.
 */
export function appVersion(startDirs?: string[]): string {
  const env = process.env.FUNGIBLE_APP_VERSION?.trim();
  if (env) return env;
  const starts = startDirs ?? [];
  if (!startDirs) {
    try { starts.push(path.dirname(fileURLToPath(import.meta.url))); } catch { /* bundled oddities */ }
    const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (res) starts.push(res, path.join(res, 'app.asar'), path.join(res, 'app'));
    starts.push(process.cwd());
  }
  for (const start of starts) {
    let cur = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      try {
        const v = fs.readFileSync(path.join(cur, 'VERSION'), 'utf8').trim();
        if (v && !v.includes('$Format')) return v.replace(/^v/, '');
      } catch { /* none here */ }
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cur, 'package.json'), 'utf8'));
        if (pkg?.name === 'fungible' && typeof pkg.version === 'string') return pkg.version;
      } catch { /* none here */ }
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return 'unknown';
}

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function fsyncPath(p: string): void {
  const fd = fs.openSync(p, 'r');
  try { fs.fsyncSync(fd); } catch { /* some filesystems refuse dir fsync */ } finally { fs.closeSync(fd); }
}

async function liveClient(opts: SnapshotOptions): Promise<Client> {
  if (opts.client) return opts.client;
  return (await import('./db.js')).db;
}

/** Full PRAGMA integrity_check (slower than quick_check; used by verify/restore). */
export async function integrityCheck(dbPath: string): Promise<string> {
  const c = createClient({ url: `file:${dbPath}` });
  try {
    const res = await c.execute('PRAGMA integrity_check');
    const msgs = res.rows.map((r) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? 'ok' : msgs.slice(0, 5).join('; ') || 'no result';
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    c.close();
  }
}

export async function quickCheck(dbPath: string): Promise<string> {
  const c = createClient({ url: `file:${dbPath}` });
  try {
    const res = await c.execute('PRAGMA quick_check');
    return String(Object.values(res.rows[0] ?? {})[0] ?? 'no result');
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    c.close();
  }
}

async function inspectDb(dbPath: string): Promise<{ userVersion: number; rowCounts: Record<string, number> }> {
  const c = createClient({ url: `file:${dbPath}` });
  try {
    const uv = await c.execute('PRAGMA user_version');
    const tables = await c.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const rowCounts: Record<string, number> = {};
    for (const t of tables.rows) {
      const name = String(t.name);
      const r = await c.execute(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
      rowCounts[name] = Number(r.rows[0].n);
    }
    return { userVersion: Number(Object.values(uv.rows[0])[0]), rowCounts };
  } finally {
    c.close();
  }
}

// --- lock -----------------------------------------------------------------

/**
 * Takeover of a stale lock is done by atomically renaming it to a unique name
 * and judging the file we actually got: if it turns out to be a fresh lock
 * (its owner created it between our stat and our rename) it is linked back
 * instead of destroyed. Releasing only unlinks a lock still carrying our token.
 */
async function acquireLock(p: Paths, waitMs: number): Promise<() => void> {
  fs.mkdirSync(p.backups, { recursive: true });
  const deadline = wallMs() + waitMs;
  const token = crypto.randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = fs.openSync(p.lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return () => {
        try {
          const cur = JSON.parse(fs.readFileSync(p.lock, 'utf8')) as { token?: string };
          if (cur.token === token) fs.unlinkSync(p.lock);
        } catch { /* gone or not ours */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    try {
      if (wallMs() - fs.statSync(p.lock).mtimeMs > LOCK_STALE_MS) {
        const moved = `${p.lock}.stale-${process.pid}-${token}`;
        fs.renameSync(p.lock, moved);
        let stillStale = true;
        try { stillStale = wallMs() - fs.statSync(moved).mtimeMs > LOCK_STALE_MS; } catch { /* treat as stale */ }
        if (!stillStale) {
          try { fs.linkSync(moved, p.lock); } catch { /* someone else holds it now */ }
        }
        fs.rmSync(moved, { force: true });
        continue;
      }
    } catch { continue; /* vanished between calls */ }
    if (wallMs() >= deadline) throw new SnapshotError('another backup is in progress (lock held)');
    await sleep(50);
  }
}

// --- listing ----------------------------------------------------------------

export interface SnapshotEntry {
  kind: 'snapshot';
  dir: string;
  name: string;
  created: string;
  reason: string;
  manifest: SnapshotManifest;
}
export interface LegacyEntry { kind: 'legacy'; name: string; created: string; files: string[] }
export type BackupEntry = SnapshotEntry | LegacyEntry;

function readManifest(dir: string): SnapshotManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest;
    if (m && typeof m.created === 'string' && Array.isArray(m.files) && !isNaN(Date.parse(m.created))) return m;
  } catch { /* not a snapshot */ }
  return null;
}

export function listSnapshots(dataDir?: string): SnapshotEntry[] {
  const p = pathsFor(dataDir);
  if (!fs.existsSync(p.backups)) return [];
  const out: SnapshotEntry[] = [];
  for (const name of fs.readdirSync(p.backups)) {
    if (name.startsWith('.')) continue;
    const dir = path.join(p.backups, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const manifest = readManifest(dir);
    if (manifest) out.push({ kind: 'snapshot', dir, name, created: manifest.created, reason: manifest.reason, manifest });
  }
  // Sort by manifest timestamp, never by filename.
  return out.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

export function listLegacy(dataDir?: string): LegacyEntry[] {
  const p = pathsFor(dataDir);
  if (!fs.existsSync(p.backups)) return [];
  const byDate = new Map<string, string[]>();
  for (const f of fs.readdirSync(p.backups)) {
    const m = /^(fungible|key|canvas-history)\.(\d{4}-\d{2}-\d{2})\.bak$/.exec(f);
    if (m) byDate.set(m[2], [...(byDate.get(m[2]) ?? []), f]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([d, files]) => ({ kind: 'legacy' as const, name: `legacy-${d}`, created: `${d}T00:00:00.000Z`, files }));
}

export function listBackups(dataDir?: string): BackupEntry[] {
  return [...listSnapshots(dataDir), ...listLegacy(dataDir)]
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

const isDaily = (s: SnapshotEntry) => s.reason === 'daily';

// --- verification -------------------------------------------------------------

export interface VerifyResult { ok: boolean; problems: string[]; manifest?: SnapshotManifest }

export async function verifySnapshot(dir: string): Promise<VerifyResult> {
  const problems: string[] = [];
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, problems: ['manifest.json missing or unreadable'] };
  for (const f of manifest.files) {
    const fp = path.join(dir, f.name);
    if (!fs.existsSync(fp)) { problems.push(`${f.name}: missing`); continue; }
    if (sha256File(fp) !== f.sha256) problems.push(`${f.name}: sha256 mismatch`);
  }
  const dbFile = path.join(dir, 'fungible.db');
  if (!manifest.files.some((f) => f.name === 'fungible.db')) problems.push('fungible.db not in manifest');
  else if (fs.existsSync(dbFile)) {
    const qc = await integrityCheck(dbFile);
    if (qc !== 'ok') problems.push(`integrity_check: ${qc}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** Cheap structural check (no hashing): manifest present and file sizes match. */
function looksIntact(s: SnapshotEntry): boolean {
  return s.manifest.files.some((f) => f.name === 'fungible.db')
    && s.manifest.files.every((f) => {
      try { return fs.statSync(path.join(s.dir, f.name)).size === f.bytes; } catch { return false; }
    });
}

// --- creation -------------------------------------------------------------------

function sanitizeReason(r: string): string {
  const s = r.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'manual';
}

/** 2026-10-02T120000 (UTC). */
function stamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, '')}`;
}

export function dailyKeepDays(): number {
  const raw = process.env.FUNGIBLE_BACKUP_DAYS;
  if (raw === undefined || raw === '') return DAILY_DAYS_DEFAULT;
  const n = parseInt(raw, 10);
  return isNaN(n) ? DAILY_DAYS_DEFAULT : n;
}

export interface SnapshotResult { dir: string; manifest: SnapshotManifest; skipped?: boolean }

export async function snapshot(reason: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const p = pathsFor(opts.dataDir);
  const now = opts.now ?? new Date();
  const slug = sanitizeReason(reason);
  const daily = slug === 'daily';
  if (!fs.existsSync(p.db)) throw new SnapshotError(`no database at ${p.db}`);

  const release = await acquireLock(p, opts.lockWaitMs ?? 60_000);
  try {
    if (daily) {
      const today = now.toISOString().slice(0, 10);
      const existing = listSnapshots(opts.dataDir)
        .filter((s) => isDaily(s) && s.created.slice(0, 10) === today && looksIntact(s));
      if (existing.length) {
        const e = existing[existing.length - 1];
        return { dir: e.dir, manifest: e.manifest, skipped: true };
      }
    }
    const result = await build(p, slug, now, opts);
    try {
      prune(p, now);
    } catch (e) {
      console.error(`fungible: backup pruning failed: ${e instanceof Error ? e.message : e}`);
    }
    return result;
  } finally {
    release();
  }
}

async function build(p: Paths, slug: string, now: Date, opts: SnapshotOptions): Promise<SnapshotResult> {
  const client = await liveClient(opts);
  const tmp = path.join(p.backups, `.tmp-${process.pid}-${wallMs().toFixed(0)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const tmpDb = path.join(tmp, 'fungible.db');
    await client.execute({ sql: 'VACUUM INTO ?', args: [tmpDb] });
    await opts.hooks?.afterVacuum?.(tmpDb);

    const qc = await quickCheck(tmpDb);
    if (qc !== 'ok') throw new SnapshotError(`snapshot copy failed integrity check: ${qc}`);
    const { userVersion, rowCounts } = await inspectDb(tmpDb);

    const names = ['fungible.db'];
    if (fs.existsSync(p.canvas)) {
      fs.copyFileSync(p.canvas, path.join(tmp, 'canvas-history.json'));
      names.push('canvas-history.json');
    }
    // Opt-in only: bundling the decryption key with the data it protects defeats
    // encrypting Plaid tokens for anyone whose backup folder leaves the machine.
    let includeKey = opts.includeKey;
    if (includeKey === undefined) {
      try {
        const r = await client.execute({
          sql: 'SELECT value FROM settings WHERE key = ?',
          args: [BACKUP_INCLUDE_KEY_SETTING],
        });
        includeKey = String(r.rows[0]?.value ?? '') === 'true';
      } catch { includeKey = false; }
    }
    if (includeKey && fs.existsSync(p.key)) {
      const k = path.join(tmp, 'key');
      fs.copyFileSync(p.key, k);
      fs.chmodSync(k, 0o600); // copy does not preserve mode
      names.push('key');
    }

    const files: ManifestFile[] = names.map((name) => {
      const fp = path.join(tmp, name);
      return { name, bytes: fs.statSync(fp).size, sha256: sha256File(fp) };
    });
    const manifest: SnapshotManifest = {
      format: 1, created: now.toISOString(), reason: slug, appVersion: appVersion(),
      userVersion, rowCounts, files,
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const n of [...names, 'manifest.json']) fsyncPath(path.join(tmp, n));
    fsyncPath(tmp);

    let finalDir = path.join(p.backups, `${stamp(now)}-${slug}`);
    for (let i = 2; fs.existsSync(finalDir); i++) finalDir = path.join(p.backups, `${stamp(now)}-${slug}-${i}`);
    fs.renameSync(tmp, finalDir);
    fsyncPath(p.backups);
    return { dir: finalDir, manifest };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e instanceof SnapshotError
      ? e
      : new SnapshotError(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- retention --------------------------------------------------------------------

/**
 * Which daily snapshots to keep: newest N calendar days, up to 4 Sundays, and
 * the earliest snapshot of each of the newest 3 months (earliest, so the
 * monthly pick is stable instead of drifting as the month goes on).
 */
export function selectDailyKeep(dailies: SnapshotEntry[], keepDays: number): Set<string> {
  const keep = new Set<string>();
  const newestFirst = [...dailies].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const perDay = new Map<string, SnapshotEntry>();
  for (const s of newestFirst) {
    const d = s.created.slice(0, 10);
    if (!perDay.has(d)) perDay.set(d, s);
  }
  const days = [...perDay.keys()].sort().reverse();
  for (const d of days.slice(0, keepDays)) keep.add(perDay.get(d)!.dir);
  const sundays = days.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0);
  for (const d of sundays.slice(0, WEEKLY_KEEP)) keep.add(perDay.get(d)!.dir);
  const months = [...new Set(days.map((d) => d.slice(0, 7)))].slice(0, MONTHLY_KEEP);
  for (const m of months) {
    const earliest = days.filter((d) => d.startsWith(m)).pop()!;
    keep.add(perDay.get(earliest)!.dir);
  }
  return keep;
}

function prune(p: Paths, now: Date): void {
  const keepDays = dailyKeepDays();
  if (keepDays <= 0) return;
  const snaps = listSnapshots(p.dataDir);
  const dailies = snaps.filter(isDaily);
  const keepSet = selectDailyKeep(dailies, keepDays);
  for (const s of dailies) if (!keepSet.has(s.dir)) fs.rmSync(s.dir, { recursive: true, force: true });

  // Named/manual: exempt from count pruning; removed after 90 days only when a
  // newer intact daily exists.
  for (const s of snaps.filter((x) => !isDaily(x))) {
    const created = Date.parse(s.created);
    if (now.getTime() - created <= NAMED_RETENTION_DAYS * DAY_MS) continue;
    if (dailies.some((d) => keepSet.has(d.dir) && Date.parse(d.created) > created && looksIntact(d))) {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }

  // Legacy flat .bak files: old keep-N-files rule, per prefix.
  const all = fs.readdirSync(p.backups);
  const legacy = [
    /^fungible\.\d{4}-\d{2}-\d{2}\.bak$/,
    /^key\.\d{4}-\d{2}-\d{2}\.bak$/,
    /^canvas-history\.\d{4}-\d{2}-\d{2}\.bak$/,
  ];
  for (const re of legacy) {
    for (const f of all.filter((n) => re.test(n)).sort().slice(0, -keepDays)) {
      fs.unlinkSync(path.join(p.backups, f));
    }
  }

  // Orphaned temp dirs from crashed runs (we hold the lock, so none is in flight).
  for (const n of all) {
    if (!n.startsWith('.tmp-')) continue;
    const full = path.join(p.backups, n);
    try {
      if (wallMs() - fs.statSync(full).mtimeMs > 3_600_000) fs.rmSync(full, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// --- last run / status --------------------------------------------------------------

export interface LastRun { at: string; ok: boolean; reason: string; dir?: string; error?: string; lastSuccessAt?: string }

export function readLastRun(dataDir?: string): LastRun | null {
  try { return JSON.parse(fs.readFileSync(pathsFor(dataDir).lastRun, 'utf8')) as LastRun; } catch { return null; }
}

export function recordLastRun(dataDir: string | undefined, run: Omit<LastRun, 'lastSuccessAt'>): void {
  const p = pathsFor(dataDir);
  try {
    fs.mkdirSync(p.backups, { recursive: true });
    const lastSuccessAt = run.ok ? run.at : readLastRun(dataDir)?.lastSuccessAt;
    fs.writeFileSync(p.lastRun, JSON.stringify({ ...run, lastSuccessAt }, null, 2) + '\n');
  } catch { /* status is best effort */ }
}

export interface BackupStatus {
  lastSuccessAt: string | null;
  lastError: string | null;
  count: number;
  legacyCount: number;
  newestDir: string | null;
}

export function getBackupStatus(dataDir?: string): BackupStatus {
  const snaps = listSnapshots(dataDir);
  const run = readLastRun(dataDir);
  const newest = snaps[snaps.length - 1];
  return {
    lastSuccessAt: run?.lastSuccessAt ?? newest?.created ?? null,
    lastError: run && !run.ok ? run.error ?? 'unknown error' : null,
    count: snaps.length,
    legacyCount: listLegacy(dataDir).length,
    newestDir: newest?.dir ?? null,
  };
}

// --- restore ----------------------------------------------------------------------

export interface RestoreOptions {
  dataDir?: string;
  now?: Date;
  /** Build's schema version; restore refuses newer snapshots. */
  appUserVersion?: number;
  /** Runs after the swap. Defaults to core/key-health.ts checkKeyHealth against the shared db. */
  keyCheck?: () => Promise<{ ok: boolean; reason?: string; linkedAccountCount?: number }>;
  /**
   * Skip ONLY the "another process has the database open" registry check.
   * Everything else (verification, version guard, pre-restore snapshot) still runs.
   */
  force?: boolean;
  /**
   * Library callers whose process already ran initDb must hand over a function
   * that closes the shared db client; otherwise restore refuses, because the
   * open client would keep writing to the replaced (unlinked) file.
   */
  closeClient?: () => void | Promise<void>;
  /** Test seam: runs after the pre-restore snapshot, before the swap. */
  beforeSwap?: () => void | Promise<void>;
}

export interface RestoreResult {
  restoredFrom: string;
  preRestoreDir: string;
  canvasRestored: boolean;
  keyRestored: boolean;
  warnings: string[];
}

export function resolveSnapshotDir(target: string, dataDir?: string): string {
  if (target === 'latest') {
    const snaps = listSnapshots(dataDir).filter((s) => s.reason !== 'pre-restore');
    if (!snaps.length) throw new SnapshotError('no snapshots found');
    return snaps[snaps.length - 1].dir;
  }
  const p = pathsFor(dataDir);
  // A name inside backups/ wins over a same-named directory in the cwd.
  for (const c of [path.join(p.backups, target), path.resolve(target)]) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
  }
  throw new SnapshotError(`no snapshot found at '${target}'`);
}

async function assertExclusive(dbPath: string): Promise<Client> {
  const c = createClient({ url: `file:${dbPath}` });
  try {
    await c.execute('PRAGMA busy_timeout = 0');
    await c.execute('BEGIN EXCLUSIVE');
    return c;
  } catch (e) {
    c.close();
    throw new SnapshotError(
      `the database is in use by another process (${e instanceof Error ? e.message : e}); quit TUI/GUI/MCP first`,
    );
  }
}

export async function restoreSnapshot(target: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const p = pathsFor(opts.dataDir);
  const now = opts.now ?? new Date();
  const dir = resolveSnapshotDir(target, opts.dataDir);
  const warnings: string[] = [];

  const v = await verifySnapshot(dir);
  if (!v.ok || !v.manifest) throw new SnapshotError(`snapshot failed verification: ${v.problems.join('; ')}`);
  const appUv = opts.appUserVersion ?? SCHEMA_USER_VERSION;
  // Trust the database itself, not the (editable) manifest: use the larger of the two.
  const dbUv = (await inspectDb(path.join(dir, 'fungible.db'))).userVersion;
  const snapUv = Math.max(v.manifest.userVersion, dbUv);
  if (snapUv > appUv) {
    throw new SnapshotError(
      `snapshot schema version ${snapUv} is newer than this build (${appUv}); update Fungible before restoring`,
    );
  }

  if (dbInitializedInProcess()) {
    if (!opts.closeClient) {
      throw new SnapshotError(
        'this process already has the database open; pass closeClient to restoreSnapshot or run `fungible restore` from a separate process',
      );
    }
    await opts.closeClient();
  }
  const others = liveInUsePids(p.dataDir);
  if (others.length && !opts.force) {
    throw new SnapshotError(
      `the database is open in other process(es) (pid ${others.join(', ')}); quit TUI/GUI/MCP first (or use --force at your own risk)`,
    );
  }
  if (others.length) {
    warnings.push(
      `WARNING: --force used while pid ${others.join(', ')} still has the database open; `
      + 'their later writes will be lost and they should be restarted immediately.',
    );
  }

  const exists = fs.existsSync(p.db);
  let preRestoreDir = '';
  if (exists) {
    const probe = await assertExclusive(p.db); // fail fast, before any copying
    await probe.execute('ROLLBACK');
    probe.close();
    const cur = createClient({ url: `file:${p.db}` });
    try {
      preRestoreDir = (await snapshot('pre-restore', { dataDir: opts.dataDir, client: cur, now })).dir;
    } finally { cur.close(); }
  }

  await opts.beforeSwap?.();
  fs.mkdirSync(p.dataDir, { recursive: true });
  const tmpDb = path.join(p.dataDir, `.fungible.db.restore-${process.pid}`);
  fs.copyFileSync(path.join(dir, 'fungible.db'), tmpDb);
  try {
    const want = v.manifest.files.find((f) => f.name === 'fungible.db')!.sha256;
    if (sha256File(tmpDb) !== want) throw new SnapshotError('copied database does not match the snapshot checksum');
    if (exists) {
      const lock = await assertExclusive(p.db);
      try {
        fs.renameSync(tmpDb, p.db);
      } finally {
        try { await lock.execute('ROLLBACK'); } catch { /* connection now on the replaced inode */ }
        lock.close();
      }
    } else {
      fs.renameSync(tmpDb, p.db);
    }
  } catch (e) {
    fs.rmSync(tmpDb, { force: true });
    throw e;
  }
  for (const s of ['-wal', '-shm', '-journal']) fs.rmSync(p.db + s, { force: true });

  const has = (n: string) => v.manifest!.files.some((f) => f.name === n);
  let canvasRestored = false;
  if (has('canvas-history.json')) {
    const t = `${p.canvas}.restore-${process.pid}`;
    fs.copyFileSync(path.join(dir, 'canvas-history.json'), t);
    fs.renameSync(t, p.canvas);
    canvasRestored = true;
  }

  let keyRestored = false;
  if (has('key')) {
    const snapKey = fs.readFileSync(path.join(dir, 'key'));
    if (fs.existsSync(p.key) && !fs.readFileSync(p.key).equals(snapKey)) {
      const aside = `${p.key}.replaced-${stamp(now)}`;
      fs.copyFileSync(p.key, aside);
      fs.chmodSync(aside, 0o600);
      warnings.push(`the existing key differed from the snapshot's; it was kept as ${aside}`);
    }
    fs.writeFileSync(p.key, snapKey, { mode: 0o600 });
    fs.chmodSync(p.key, 0o600);
    keyRestored = true;
  }

  const check = opts.keyCheck ?? (async () => (await import('./key-health.js')).checkKeyHealth());
  try {
    const h = await check();
    if (!h.ok) {
      warnings.push(
        `WARNING: the encryption key (${h.reason}) cannot decrypt the restored Plaid tokens for `
        + `${h.linkedAccountCount ?? 'some'} linked account(s); they will need to be re-linked `
        + 'unless you restore the matching key file.',
      );
    }
  } catch (e) {
    warnings.push(`could not check key health: ${e instanceof Error ? e.message : e}`);
  }

  return { restoredFrom: dir, preRestoreDir, canvasRestored, keyRestored, warnings };
}
