// CLI entry for `fungible backup [--reason <text>]`, `fungible backup list [--json]`,
// `fungible backup verify <dir|latest>` and `fungible restore <dir|latest>`.
// Dispatched from bin/fungible, which forwards the subcommand word as
// argv[2] ("backup" or "restore") followed by the remaining flags.
//
// Backups live next to the database; they do not protect against disk loss.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client';
import {
  snapshot, listBackups, verifySnapshot, restoreSnapshot, resolveSnapshotDir,
} from '../core/snapshot.js';

export interface CliContext {
  dataDir?: string;
  client?: Client;
  now?: Date;
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = [
  'Usage: fungible backup [--reason <text>]',
  '       fungible backup list [--json]',
  '       fungible backup verify <dir|latest>',
  '       fungible restore <dir|latest>',
].join('\n');

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'restore') {
      const target = rest.find((a) => !a.startsWith('--'));
      if (!target) { ctx.err(USAGE); return 1; }
      const r = await restoreSnapshot(target, { dataDir: ctx.dataDir, now: ctx.now });
      ctx.out(`Restored ${r.restoredFrom}`);
      if (r.preRestoreDir) ctx.out(`Previous state saved as ${r.preRestoreDir}`);
      if (r.canvasRestored) ctx.out('Canvas history restored.');
      if (r.keyRestored) ctx.out('Encryption key restored from the snapshot.');
      for (const w of r.warnings) ctx.err(w);
      return 0;
    }
    if (cmd !== 'backup') { ctx.err(USAGE); return 1; }

    const [sub, ...args] = rest;
    if (sub === 'list') {
      const entries = listBackups(ctx.dataDir);
      if (args.includes('--json')) {
        ctx.out(JSON.stringify(entries.map((e) => e.kind === 'legacy'
          ? { kind: 'legacy', name: e.name, created: e.created, files: e.files }
          : {
              kind: 'snapshot', name: e.name, dir: e.dir, created: e.created, reason: e.reason,
              userVersion: e.manifest.userVersion, appVersion: e.manifest.appVersion,
              files: e.manifest.files.map((f) => f.name),
            }), null, 2));
        return 0;
      }
      if (!entries.length) { ctx.out('No backups found.'); return 0; }
      for (const e of entries) {
        ctx.out(e.kind === 'legacy'
          ? `${e.created.slice(0, 10)}  legacy  ${e.files.join(', ')}`
          : `${e.created.slice(0, 19)}Z  ${e.reason.padEnd(14)}  ${e.name}`);
      }
      return 0;
    }
    if (sub === 'verify') {
      if (!args[0]) { ctx.err(USAGE); return 1; }
      const dir = resolveSnapshotDir(args[0], ctx.dataDir);
      const v = await verifySnapshot(dir);
      if (v.ok) { ctx.out(`OK ${dir}`); return 0; }
      ctx.err(`FAILED ${dir}`);
      for (const p of v.problems) ctx.err(`  ${p}`);
      return 1;
    }

    let reason = 'manual';
    if (sub !== undefined) {
      if (sub !== '--reason' || !args[0]) { ctx.err(USAGE); return 1; }
      reason = args[0];
    }
    const r = await snapshot(reason, { dataDir: ctx.dataDir, client: ctx.client, now: ctx.now });
    ctx.out(`${r.skipped ? 'Already backed up today: ' : 'Backup created: '}${r.dir}`);
    return 0;
  } catch (e) {
    ctx.err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  }).then((code) => process.exit(code));
}
