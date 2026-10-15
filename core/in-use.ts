/**
 * Registry of local processes that have the database open, so a restore can
 * refuse instead of renaming a new file over one another process still has
 * open (its next write would go to an unlinked inode and be lost).
 *
 * Each process that runs initDb drops an empty marker file
 * `<dataDir>/.in-use/<pid>` and removes it on normal exit. Everything here is
 * best effort and must never fail startup; a killed process leaves a stale
 * marker which readers detect by pid liveness and clean up.
 *
 * No database import: this module is safe to load from restore code paths.
 */
import fs from 'node:fs';
import path from 'node:path';

let initializedInProcess = false;
const registered = new Set<string>();

const markerDir = (dataDir: string) => path.join(dataDir, '.in-use');

/** True once initDb has registered this process (the shared db client is live here). */
export function dbInitializedInProcess(): boolean {
  return initializedInProcess;
}

/** Called by initDb. Never throws. */
export function registerInUse(dataDir: string): void {
  initializedInProcess = true;
  try {
    const dir = markerDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, String(process.pid));
    fs.writeFileSync(file, '');
    if (!registered.has(file)) {
      registered.add(file);
      process.on('exit', () => {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
      });
    }
  } catch { /* read-only dir etc: restore falls back to lock-based detection */ }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live pids (other than `selfPid`) registered as using the database. Cleans stale markers. */
export function liveInUsePids(dataDir: string, selfPid: number = process.pid): number[] {
  const dir = markerDir(dataDir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: number[] = [];
  for (const n of names) {
    const pid = Number(n);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === selfPid) continue;
    if (alive(pid)) out.push(pid);
    else { try { fs.unlinkSync(path.join(dir, n)); } catch { /* ignore */ } }
  }
  return out.sort((a, b) => a - b);
}
