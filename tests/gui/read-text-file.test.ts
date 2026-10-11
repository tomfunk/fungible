import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBalanceImportFile } from '../../gui/main/read-text-file.js';
import { BALANCE_IMPORT_MAX_BYTES } from '../../core/balance-import.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fungible-readtext-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readBalanceImportFile', () => {
  it('reads a small file', () => {
    const p = join(dir, 'small.csv');
    writeFileSync(p, 'date,account,balance\n2026-04-01,Checking,1000\n');
    expect(readBalanceImportFile(p)).toEqual({ path: p, fileName: 'small.csv', text: 'date,account,balance\n2026-04-01,Checking,1000\n' });
  });

  it('derives fileName from posix and windows-style paths', () => {
    // statSync needs a real path, so check the split via a real file whose
    // name contains a backslash (valid on posix), plus the plain posix case.
    const p = join(dir, 'a.csv');
    writeFileSync(p, 'x');
    expect(readBalanceImportFile(p).fileName).toBe('a.csv');
    if (process.platform !== 'win32') {
      const w = join(dir, 'C:\\Users\\me\\hist.csv');
      writeFileSync(w, 'x');
      expect(readBalanceImportFile(w).fileName).toBe('hist.csv');
    }
  });

  it('accepts a file of exactly the limit', () => {
    const p = join(dir, 'exact.csv');
    writeFileSync(p, '');
    truncateSync(p, BALANCE_IMPORT_MAX_BYTES);
    expect(readBalanceImportFile(p).text.length).toBe(BALANCE_IMPORT_MAX_BYTES);
  });

  it('rejects limit+1 bytes with the real message', () => {
    const p = join(dir, 'big.csv');
    writeFileSync(p, '');
    truncateSync(p, BALANCE_IMPORT_MAX_BYTES + 1);
    expect(() => readBalanceImportFile(p)).toThrow('That file is larger than 5 MB, the limit for a balance history import.');
  });

  it('throws on a missing file', () => {
    expect(() => readBalanceImportFile(join(dir, 'nope.csv'))).toThrow(/ENOENT/);
  });
});
