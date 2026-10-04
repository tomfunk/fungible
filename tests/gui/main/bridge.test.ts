import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electronMock } from '../../helpers/makeElectronMock.js';
import { useTempCsv } from '../../helpers/tempCsv.js';

// DATA SAFETY: registry/bridge import core/db.js, which would open the real ~/.fungible DB.
vi.mock('../../../core/db.js', async () => ({
  db: await (await import('../../helpers/makeTestDb.js')).makeTestDb(),
}));
vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));
vi.mock('../../../core/plaid.js', async (orig) => ({
  ...(await orig<typeof import('../../../core/plaid.js')>()),
  isPlaidConfigured: vi.fn(() => false),
}));
vi.mock('../../../gui/main/plaid-link.js', () => ({
  cancelActivePlaidLink: vi.fn(),
  runPlaidLink: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { isPlaidConfigured } from '../../../core/plaid.js';
import { cancelActivePlaidLink } from '../../../gui/main/plaid-link.js';
import { registerBridge, fullRegistry } from '../../../gui/main/bridge.js';

const call = (ns: string, fn: string, args: unknown[] = []) => electronMock.invoke('bridge:call', ns, fn, args);
const tmp = useTempCsv('bridge-');
const outDir = mkdtempSync(join(tmpdir(), 'bridge-out-'));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

beforeEach(() => {
  electronMock.reset();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(isPlaidConfigured).mockReset();
  vi.mocked(cancelActivePlaidLink).mockReset();
  registerBridge();
});

describe('bridge:call dispatch', () => {
  it('registers only bridge:call', () => {
    expect([...electronMock.handlers.keys()]).toEqual(['bridge:call']);
  });

  it('dispatches to the registry against the (in-memory) DB', async () => {
    expect(await call('queries', 'getUncategorizedCount', ['2020-01-01', '2030-01-01'])).toBe(0);
  });

  it('rejects unknown namespaces and functions with a precise message', async () => {
    await expect(call('nope', 'x')).rejects.toThrow(new Error('Unknown bridge call: nope.x'));
    await expect(call('queries', 'nope')).rejects.toThrow(new Error('Unknown bridge call: queries.nope'));
  });

  it.each([
    ['constructor', 'x'],
    ['__proto__', 'toString'],
    ['queries', 'constructor'],
    ['queries', 'hasOwnProperty'],
    ['queries', '__proto__'],
    ['queries', 'toString'],
    ['hasOwnProperty', 'call'],
  ])('rejects prototype-chain access %s.%s', async (ns, fn) => {
    await expect(call(ns, fn)).rejects.toThrow(`Unknown bridge call: ${ns}.${fn}`);
  });

  it('rejects an own export that is not a function', async () => {
    const q = fullRegistry.queries as Record<string, unknown>;
    q.notAFunction = 5;
    try {
      await expect(call('queries', 'notAFunction')).rejects.toThrow('Unknown bridge call: queries.notAFunction');
    } finally {
      delete q.notAFunction;
    }
  });

  it('every registry namespace is an own key whose leaves are all functions', () => {
    const names = Object.keys(fullRegistry);
    expect(names).toEqual(expect.arrayContaining(['queries', 'sync', 'files', 'plaid', 'app']));
    for (const ns of names) {
      expect(Object.hasOwn(fullRegistry, ns)).toBe(true);
      for (const [fn, f] of Object.entries((fullRegistry as any)[ns])) {
        expect(typeof f, `${ns}.${fn}`).toBe('function');
      }
    }
  });
});

describe('files.pickCsv', () => {
  it('returns null when canceled or when no path is selected', async () => {
    expect(await call('files', 'pickCsv')).toBeNull();
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await call('files', 'pickCsv')).toBeNull();
    // canceled wins even if a path is (oddly) present
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/nonexistent.csv'] });
    expect(await call('files', 'pickCsv')).toBeNull();
  });

  it('returns the parsed file with its path, name and hash, filtered to csv', async () => {
    const path = tmp.csv('Date,Name,Amount\n2024-01-05,Coffee,4.50\n', 'pick.csv');
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    const out = (await call('files', 'pickCsv')) as any;
    expect(out.path).toBe(path);
    expect(out.fileName).toBe('pick.csv');
    expect(out.headers).toEqual(['Date', 'Name', 'Amount']);
    expect(out.rows).toEqual([['2024-01-05', 'Coffee', '4.50']]);
    expect(out.lines).toHaveLength(1);
    expect(out.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(electronMock.dialog.showOpenDialog.mock.calls[0][0]).toMatchObject({
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
  });
});

describe('files.pickText', () => {
  it('returns null when canceled', async () => {
    expect(await call('files', 'pickText')).toBeNull();
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/nonexistent.txt'] });
    expect(await call('files', 'pickText')).toBeNull();
  });

  it('returns the raw file text with path and name, filtered to csv/txt', async () => {
    const path = tmp.csv('Date,Account,Balance\n2024-01-01,A,1\n', 'bal.csv');
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    expect(await call('files', 'pickText')).toEqual({
      path, fileName: 'bal.csv', text: 'Date,Account,Balance\n2024-01-01,A,1\n',
    });
    expect(electronMock.dialog.showOpenDialog.mock.calls[0][0]).toMatchObject({
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    });
  });
});

describe('files.saveCsv', () => {
  it('canceled -> false and nothing written', async () => {
    const target = join(outDir, 'canceled.csv');
    electronMock.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: target });
    expect(await call('files', 'saveCsv', ['a,b', 'x.csv'])).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('no filePath -> false', async () => {
    electronMock.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: undefined });
    expect(await call('files', 'saveCsv', ['a,b', 'x.csv'])).toBe(false);
  });

  it('writes the exact content and offers the suggested name', async () => {
    const target = join(outDir, 'saved.csv');
    electronMock.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target });
    const content = 'Date,Name\n2024-01-05,"Café, ünï"\n';
    expect(await call('files', 'saveCsv', [content, 'export.csv'])).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(content);
    expect(electronMock.dialog.showSaveDialog.mock.calls[0][0]).toMatchObject({
      defaultPath: 'export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
  });
});

describe('app.getVersion', () => {
  const PLACEHOLDER = '0.0.0-nobumpnecessary';

  it('returns a real version as-is without shelling out', async () => {
    electronMock.app.getVersion.mockImplementation(() => '2.3.4');
    expect(await call('app', 'getVersion')).toBe('2.3.4');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('placeholder -> git describe output with the leading v stripped', async () => {
    electronMock.app.getVersion.mockImplementation(() => PLACEHOLDER);
    vi.mocked(execFileSync).mockReturnValue('v1.9.1\n' as any);
    expect(await call('app', 'getVersion')).toBe('1.9.1');
    expect(vi.mocked(execFileSync).mock.calls[0].slice(0, 2)).toEqual(['git', ['describe', '--tags']]);
    expect(vi.mocked(execFileSync).mock.calls[0][2]).toMatchObject({ cwd: '/fake/app' });
  });

  it('placeholder + git failing -> the placeholder', async () => {
    electronMock.app.getVersion.mockImplementation(() => PLACEHOLDER);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no git'); });
    expect(await call('app', 'getVersion')).toBe(PLACEHOLDER);
  });

  // Smell: between tags `git describe` yields "v1.9.1-5-gabc1234"; only the "v" is
  // stripped, so a dev checkout shows "1.9.1-5-gabc1234". Pinned as current behaviour.
  it('placeholder + commits past a tag keeps the describe suffix (current behaviour)', async () => {
    electronMock.app.getVersion.mockImplementation(() => PLACEHOLDER);
    vi.mocked(execFileSync).mockReturnValue('v1.9.1-5-gabc1234\n' as any);
    expect(await call('app', 'getVersion')).toBe('1.9.1-5-gabc1234');
  });
});

describe('plaid', () => {
  it.each([true, false])('isConfigured follows isPlaidConfigured (%s)', async (configured) => {
    vi.mocked(isPlaidConfigured).mockReturnValue(configured);
    expect(await call('plaid', 'isConfigured')).toBe(configured);
  });

  it('cancelLink cancels the active Plaid link flow', async () => {
    expect(await call('plaid', 'cancelLink')).toBeUndefined();
    expect(cancelActivePlaidLink).toHaveBeenCalledTimes(1);
  });
});
