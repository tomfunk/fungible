import { app, dialog, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseCSV } from '../../core/csv.js';
import { readBalanceImportFile } from './read-text-file.js';
import { isPlaidConfigured } from '../../core/plaid.js';
import { getDefaultDaysRequested } from '../../core/settings.js';
import { cancelActivePlaidLink, runPlaidLink } from './plaid-link.js';
import { registry } from './registry.js';

const plaid = {
  isConfigured: async (): Promise<boolean> => isPlaidConfigured(),
  getDefaultDaysRequested,
  linkBank: (daysRequested?: number, updateItemId?: string) => runPlaidLink(daysRequested, updateItemId),
  // Closing the link dialog abandons the flow. Without telling main, the flow
  // stays in flight for its full 10-minute timeout and refuses every other link
  // or update the user tries in the meantime.
  cancelLink: async (): Promise<void> => cancelActivePlaidLink(),
};

const files = {
  pickCsv: async (): Promise<{ path: string; headers: string[]; rows: string[][]; lines: number[]; fileName: string; fileHash: string } | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Import CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const path = result.filePaths[0];
    return { path, ...parseCSV(path) };
  },
  // Raw text pick for the balance-history import: core takes CSV text, so no
  // parsing here. Size is checked before reading so a huge file never lands in
  // memory (core enforces the same cap on the text it is handed).
  pickText: async (): Promise<{ path: string; fileName: string; text: string } | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Import balance history',
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readBalanceImportFile(result.filePaths[0]);
  },
  // Writes already-built file content to a user-chosen path. Content is built
  // main-side (registry.transactions.exportTransactionsCsv, backed by
  // core/export.ts) and handed here just to save — this call never reaches
  // back into core itself.
  saveCsv: async (content: string, suggestedName: string): Promise<boolean> => {
    const result = await dialog.showSaveDialog({
      title: 'Export Transactions',
      defaultPath: suggestedName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, content);
    return true;
  },
};

// package.json's "version" field is cosmetic (see .github/workflows/release.yml)
// — this repo never hand-bumps it, and CI only syncs it to the real
// git-tag-derived version when building an installer artifact. Anyone running
// from a local source checkout (no installer build step) gets that literal
// placeholder back from app.getVersion(), so fall back to `git describe
// --tags` in that case — tags are the actual source of truth here. Wrapped in
// try/catch: this should never fire for a packaged installer (where CI has
// already synced package.json and there's no .git directory to shell out to
// anyway), and must degrade gracefully if git isn't on PATH.
const PLACEHOLDER_VERSION = '0.0.0-nobumpnecessary';

const appInfo = {
  getVersion: async (): Promise<string> => {
    const version = app.getVersion();
    if (version !== PLACEHOLDER_VERSION) return version;
    try {
      const described = execFileSync('git', ['describe', '--tags'], {
        cwd: app.getAppPath(),
        encoding: 'utf8',
      }).trim();
      // Tags are written as "v1.9.1" — strip the "v" so this stays a bare
      // version string, same shape as app.getVersion()'s own return value.
      // The renderer (SideNav) is the one place that adds the "v" prefix.
      return described.replace(/^v/, '');
    } catch {
      return version;
    }
  },
};

export const fullRegistry = { ...registry, files, plaid, app: appInfo } as const;

export function registerBridge() {
  ipcMain.handle('bridge:call', (_e, ns: string, fn: string, args: unknown[]) => {
    // Object.hasOwn gates keep prototype-chain properties (constructor,
    // __proto__, hasOwnProperty…) out of reach of the renderer.
    const namespace = Object.hasOwn(fullRegistry, ns)
      ? (fullRegistry as Record<string, Record<string, unknown>>)[ns]
      : undefined;
    const f = namespace && Object.hasOwn(namespace, fn) ? namespace[fn] : undefined;
    if (typeof f !== 'function') throw new Error(`Unknown bridge call: ${ns}.${fn}`);
    return f(...args);
  });
}
