/**
 * File-backed temp database helpers for multi-process / incident tests.
 *
 * Safety: every path is resolved (and realpath'd) and refused if it is, or
 * lives under, the real ~/.fungible, equals an inherited FUNGIBLE_DATA_DIR, or
 * is not under the OS temp dir. A test must never touch real user data.
 *
 * Schema: reuses the SCHEMA constant from makeTestDb (no initDb import, so no
 * core/db side effects in the parent process).
 */
import { createClient, type Client } from '@libsql/client';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA } from './makeTestDb.js';

function real(p: string, depth = 0): string {
  const abs = path.resolve(p);
  // realpath the deepest existing ancestor so symlinks are followed even for
  // paths that do not exist yet (including dangling symlinks).
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(cur); } catch { st = undefined; }
    if (st) {
      try { return path.join(fs.realpathSync(cur), ...rest); } catch {
        if (st.isSymbolicLink() && depth < 20) {
          const t = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
          return real(path.join(t, ...rest), depth + 1);
        }
        return path.join(cur, ...rest);
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.join(cur, ...rest);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throws unless `p` is safely inside the OS temp dir and away from real data. */
export function assertSafeTempPath(p: string): string {
  const resolved = path.resolve(p);
  const target = real(resolved);
  const forbidden = [path.join(os.homedir(), '.fungible')];
  if (process.env.FUNGIBLE_DATA_DIR) forbidden.push(process.env.FUNGIBLE_DATA_DIR);
  for (const f of forbidden) {
    for (const fr of new Set([path.resolve(f), real(f)])) {
      if (within(resolved, fr) || within(target, fr)) {
        throw new Error(`refusing to use ${p}: it is inside protected data dir ${fr}`);
      }
    }
  }
  if (!within(target, real(os.tmpdir()))) {
    throw new Error(`refusing to use ${p}: not under the OS temp dir`);
  }
  return target;
}

export interface TempDataDir {
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

/** mkdtemp under os.tmpdir(); `dbPath` is `<dir>/fungible.db` (what core/db.ts opens). */
export function makeTempDataDir(prefix = 'fungible-test-'): TempDataDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    assertSafeTempPath(dir);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const dbPath = path.join(dir, 'fungible.db');
  return {
    dir,
    dbPath,
    cleanup() {
      assertSafeTempPath(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** File-backed libsql client at `dbPath` with the test schema applied. */
export async function openTempDb(dbPath: string): Promise<Client> {
  assertSafeTempPath(dbPath);
  const db = createClient({ url: `file:${dbPath}` });
  await db.execute('PRAGMA foreign_keys = ON');
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  return db;
}

export interface WriterResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed last JSON line of stdout from db-writer-child, or null. */
  report: { id: string; ok: number; errors: string[] } | null;
}

export interface SpawnWriterOptions {
  /** Directory used as FUNGIBLE_DATA_DIR (must hold/receive fungible.db). */
  dataDir: string;
  /** Child script; defaults to db-writer-child.ts. */
  script?: string;
  /** Extra env (e.g. WRITER_ID, WRITER_BATCHES). FUNGIBLE_DATA_DIR is always forced. */
  env?: Record<string, string>;
}

const DEFAULT_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db-writer-child.ts');

/** Runs `node --import tsx <script>` with FUNGIBLE_DATA_DIR pinned to the temp dir. */
export function spawnWriter(opts: SpawnWriterOptions): Promise<WriterResult> {
  assertSafeTempPath(opts.dataDir);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', opts.script ?? DEFAULT_CHILD], {
      env: { ...process.env, ...opts.env, FUNGIBLE_DATA_DIR: opts.dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      let report: WriterResult['report'] = null;
      const last = stdout.trim().split('\n').filter(Boolean).pop();
      if (last) {
        try { report = JSON.parse(last); } catch { /* leave null */ }
      }
      resolve({ exitCode, stdout, stderr, report });
    });
  });
}
