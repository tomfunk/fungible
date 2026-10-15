import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createClient } from '@libsql/client';
import { snapshot, listSnapshots, restoreSnapshot } from '../core/snapshot.js';

// Real multi-process tests using tests/helpers/snapshot-child.ts. Temp dirs
// only; synchronisation is by file barriers, never sleeps.
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fungible-snapproc-'));
const CHILD = path.resolve('tests/helpers/snapshot-child.ts');
let dir: string;
let n = 0;
const alive: ChildProcess[] = [];

interface Child { proc: ChildProcess; done: Promise<{ code: number | null; out: Record<string, unknown> }> }

function spawnChild(args: Record<string, unknown>): Child {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, JSON.stringify({ dataDir: dir, ...args })], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FUNGIBLE_DATA_DIR: dir },
  });
  alive.push(proc);
  let stdout = '';
  proc.stdout!.on('data', (d) => (stdout += d));
  const done = new Promise<{ code: number | null; out: Record<string, unknown> }>((resolve) => {
    proc.on('close', (code) => {
      const last = stdout.trim().split('\n').filter(Boolean).pop();
      let out: Record<string, unknown> = {};
      try { out = last ? JSON.parse(last) : {}; } catch { /* leave empty */ }
      resolve({ code, out });
    });
  });
  return { proc, done };
}

async function waitForFile(p: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  dir = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const c = createClient({ url: `file:${path.join(dir, 'fungible.db')}` });
  await c.batch(['CREATE TABLE notes (body TEXT)', "INSERT INTO notes VALUES ('one'), ('two')"]);
  c.close();
});

afterAll(() => {
  for (const p of alive) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const backups = () => path.join(dir, 'backups');
const noKeyIssue = async () => ({ ok: true });

describe('snapshot across processes', () => {
  it('three concurrent daily callers produce one snapshot and no leftovers', async () => {
    const release = path.join(dir, 'go');
    const kids = [1, 2, 3].map(() => spawnChild({
      mode: 'snapshot', reason: 'daily', now: '2026-10-02T12:00:00Z', releaseFile: release, lockWaitMs: 25_000,
    }));
    fs.writeFileSync(release, '');
    const results = await Promise.all(kids.map((k) => k.done));

    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(results.filter((r) => r.out.skipped !== true)).toHaveLength(1);
    expect(listSnapshots(dir)).toHaveLength(1);
    const left = fs.readdirSync(backups()).filter((x) => x === '.lock' || x.startsWith('.tmp-') || x.includes('.stale-'));
    expect(left).toEqual([]);
  }, 60_000);

  it('restore refuses while another process idles on the database; --force proceeds loudly', async () => {
    const snap = await snapshot('manual', { dataDir: dir, client: createClient({ url: `file:${path.join(dir, 'fungible.db')}` }) });
    const ready = path.join(dir, 'ready');
    const release = path.join(dir, 'release');
    const holder = spawnChild({ mode: 'idle-hold', readyFile: ready, releaseFile: release });
    await waitForFile(ready);
    const pid = Number(fs.readFileSync(ready, 'utf8'));
    expect(fs.existsSync(path.join(dir, '.in-use', String(pid)))).toBe(true);

    try {
      await expect(restoreSnapshot(snap.dir, { dataDir: dir, keyCheck: noKeyIssue }))
        .rejects.toThrow(new RegExp(`pid ${pid}.*quit TUI/GUI/MCP first`));
      expect(listSnapshots(dir).some((s) => s.reason === 'pre-restore')).toBe(false);

      const r = await restoreSnapshot(snap.dir, { dataDir: dir, force: true, keyCheck: noKeyIssue });
      expect(r.warnings.join('\n')).toMatch(/WARNING: --force/);
      expect(listSnapshots(dir).some((s) => s.reason === 'pre-restore')).toBe(true);
    } finally {
      fs.writeFileSync(release, '');
      await holder.done;
    }
    expect(fs.existsSync(path.join(dir, '.in-use', String(pid)))).toBe(false);
  }, 60_000);

  it('recovers after a snapshot process is SIGKILLed mid-build', async () => {
    const ready = path.join(dir, 'ready');
    const victim = spawnChild({ mode: 'hang-after-vacuum', reason: 'daily', now: '2026-10-02T12:00:00Z', readyFile: ready });
    await waitForFile(ready);
    victim.proc.kill('SIGKILL');
    await victim.done;

    const lock = path.join(backups(), '.lock');
    const tmp = fs.readdirSync(backups()).filter((x) => x.startsWith('.tmp-'));
    expect(fs.existsSync(lock)).toBe(true);
    expect(tmp).toHaveLength(1);
    expect(listSnapshots(dir)).toHaveLength(0);

    const old = new Date(Date.now() - 3 * 3_600_000);
    fs.utimesSync(lock, old, old);
    fs.utimesSync(path.join(backups(), tmp[0]), old, old);

    const c = createClient({ url: `file:${path.join(dir, 'fungible.db')}` });
    const r = await snapshot('daily', { dataDir: dir, client: c, now: new Date('2026-10-02T12:00:00Z'), lockWaitMs: 5000 });
    c.close();
    expect(r.skipped).toBeUndefined();
    expect(listSnapshots(dir)).toHaveLength(1);
    const left = fs.readdirSync(backups()).filter((x) => x === '.lock' || x.startsWith('.tmp-'));
    expect(left).toEqual([]);
  }, 60_000);
});
