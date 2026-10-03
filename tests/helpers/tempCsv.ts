import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

export interface TempCsvDir {
  /** Writes `text` to a new uniquely named file and returns its absolute path. */
  csv(text: string, name?: string): string;
  /** Directory holding the files. */
  readonly dir: string;
  /** Removes the directory. Idempotent. */
  dispose(): void;
}

/**
 * Creates a temp dir for CSV fixtures. Call at module scope or inside a
 * describe; cleanup is registered with afterAll automatically (pass
 * `{ autoCleanup: false }` to manage `dispose()` yourself).
 *
 *   const { csv } = useTempCsv('bh-import-');
 *   const p = csv('Date,Account,Balance\n...');
 */
export function useTempCsv(prefix = 'csv-', opts: { autoCleanup?: boolean } = {}): TempCsvDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let n = 0;
  const dispose = () => rmSync(dir, { recursive: true, force: true });
  if (opts.autoCleanup !== false) afterAll(dispose);
  return {
    dir,
    csv(text, name) {
      const p = join(dir, name ?? `f${n++}.csv`);
      writeFileSync(p, text);
      return p;
    },
    dispose,
  };
}
