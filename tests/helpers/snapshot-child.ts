/**
 * Child process for multi-process backup/restore tests. Spawn with
 * `node --import tsx tests/helpers/snapshot-child.ts '<json>'` (same mechanism
 * as db-writer-child.ts); do not import from a test.
 *
 * argv[2] = JSON {
 *   dataDir: string,                       required, temp dir (becomes FUNGIBLE_DATA_DIR)
 *   mode: 'snapshot' | 'idle-hold' | 'hang-after-vacuum' | 'restore',
 *   reason?: string,                       snapshot reason, default 'daily'
 *   now?: string,                          ISO; fixed clock passed as options.now
 *   readyFile?: string,                    written by the child when it is parked/ready
 *   releaseFile?: string,                  child waits (poll, hard timeout) until it exists
 *   lockWaitMs?: number,
 *   target?: string,                       restore target ('latest' | dir | name)
 *   force?: boolean,                       passed through to restoreSnapshot
 * }
 *
 * Modes:
 *  snapshot           wait for releaseFile (if given), snapshot(reason, {dataDir, now, lockWaitMs}),
 *                     print one JSON line {ok:true, dir, skipped?} or {ok:false, error}.
 *  idle-hold          initDb() against dataDir (registers in-use like the real apps), write
 *                     readyFile, block until releaseFile exists, close, print {ok:true}.
 *  hang-after-vacuum  snapshot() with an afterVacuum hook that writes readyFile then blocks
 *                     forever; the parent is expected to SIGKILL it.
 *  restore            restoreSnapshot(target, {dataDir, force}); print {ok:true, ...result}
 *                     or {ok:false, error}.
 * Exit code 0 when ok, 1 otherwise. All waits have a hard 30s timeout.
 */
import fs from 'node:fs';

interface Args {
  dataDir: string;
  mode: 'snapshot' | 'idle-hold' | 'hang-after-vacuum' | 'restore';
  reason?: string;
  now?: string;
  readyFile?: string;
  releaseFile?: string;
  lockWaitMs?: number;
  target?: string;
  force?: boolean;
}

const args = JSON.parse(process.argv[2] ?? '{}') as Args;
if (!args.dataDir || !args.mode) {
  console.log(JSON.stringify({ ok: false, error: 'dataDir and mode are required' }));
  process.exit(1);
}
// paths.ts reads this at import time, so set it before any core import.
process.env.FUNGIBLE_DATA_DIR = args.dataDir;

const HARD_TIMEOUT_MS = 30_000;

async function waitForFile(p: string): Promise<void> {
  const deadline = Date.now() + HARD_TIMEOUT_MS;
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const now = args.now ? new Date(args.now) : undefined;

async function main(): Promise<Record<string, unknown>> {
  const snap = await import('../../core/snapshot.js');
  switch (args.mode) {
    case 'snapshot': {
      if (args.releaseFile) await waitForFile(args.releaseFile);
      const r = await snap.snapshot(args.reason ?? 'daily', {
        dataDir: args.dataDir, now, lockWaitMs: args.lockWaitMs,
      });
      return { ok: true, dir: r.dir, skipped: r.skipped };
    }
    case 'idle-hold': {
      const { initDb } = await import('../../core/db.js');
      await initDb();
      if (args.readyFile) fs.writeFileSync(args.readyFile, String(process.pid));
      if (args.releaseFile) await waitForFile(args.releaseFile);
      return { ok: true };
    }
    case 'hang-after-vacuum': {
      const r = await snap.snapshot(args.reason ?? 'daily', {
        dataDir: args.dataDir, now, lockWaitMs: args.lockWaitMs,
        hooks: {
          afterVacuum: async () => {
            if (args.readyFile) fs.writeFileSync(args.readyFile, String(process.pid));
            await new Promise<never>(() => { setInterval(() => {}, 1 << 30); });
          },
        },
      });
      return { ok: true, dir: r.dir };
    }
    case 'restore': {
      const opts = { dataDir: args.dataDir, now, force: args.force } as Parameters<typeof snap.restoreSnapshot>[1];
      const r = await snap.restoreSnapshot(args.target ?? 'latest', opts);
      return { ok: true, ...r };
    }
  }
}

try {
  const out = await main();
  console.log(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}
