import { readFileSync, statSync } from 'node:fs';
import { BALANCE_IMPORT_MAX_BYTES } from '../../core/balance-import.js';

/**
 * Reads a balance-history import file as utf8. Size is checked before reading
 * so a huge file never lands in memory (core enforces the same cap on the text
 * it is handed).
 */
export function readBalanceImportFile(path: string): { path: string; fileName: string; text: string } {
  if (statSync(path).size > BALANCE_IMPORT_MAX_BYTES) {
    throw new Error(`That file is larger than ${BALANCE_IMPORT_MAX_BYTES / 1024 / 1024} MB, the limit for a balance history import.`);
  }
  return { path, fileName: path.split(/[\\/]/).pop() ?? path, text: readFileSync(path, 'utf8') };
}
