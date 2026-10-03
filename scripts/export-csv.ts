// CLI entry for `fungible export` (Issue #18). Dispatched from bin/fungible,
// which strips the `export` subcommand word before forwarding the rest of
// argv here (so process.argv[2..] is exactly the flag list below).
//
// No argv-parsing library is installed in this repo (see scripts/import-csv.ts
// for the existing hand-rolled convention) -- parseArgs below follows the same
// pattern: plain string/boolean flags, no nested commands.

import 'dotenv/config';
import fs from 'node:fs';
import { initDb } from '../core/db.js';
import { exportTransactionsCsv, type ExportFilters } from '../core/export.js';
import type { Filter } from '../core/filters.js';

const USAGE = 'Usage: fungible export --from <date> --to <date> [--format csv] '
  + '[--category <name>] [--account <id>] [--tag <name>] [--search <term>] '
  + '[--include-hidden] [-o <path>]';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && a !== '-o') continue;
    const key = a === '-o' ? 'output' : a.slice(2);
    if (key === 'include-hidden') { out.includeHidden = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const from = typeof args.from === 'string' ? args.from : undefined;
  const to = typeof args.to === 'string' ? args.to : undefined;
  if (!from || !to) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const format = typeof args.format === 'string' ? args.format : 'csv';
  if (format !== 'csv') {
    console.error(`Unsupported format '${format}' — only 'csv' is implemented.`);
    process.exit(1);
    return;
  }

  const filter: Filter = {};
  if (typeof args.category === 'string') filter.categories = [args.category];
  if (typeof args.account === 'string') filter.accounts = [args.account];
  if (typeof args.tag === 'string') filter.tags = [{ name: args.tag, mode: 'has' }];

  const opts: ExportFilters = {
    from,
    to,
    filter: Object.keys(filter).length ? filter : undefined,
    search: typeof args.search === 'string' ? args.search : undefined,
    includeHidden: args.includeHidden === true,
  };

  await initDb();
  const csv = await exportTransactionsCsv(opts);

  const output = typeof args.output === 'string' ? args.output : undefined;
  if (output) {
    fs.writeFileSync(output, csv);
    console.error(`Wrote ${output}`);
  } else {
    process.stdout.write(csv);
  }
}

main().catch((e) => {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
