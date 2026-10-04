import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { electronMock, makeWindow } from '../../helpers/makeElectronMock.js';

// DATA SAFETY: app.ts imports core/paths (reads FUNGIBLE_DATA_DIR at import) and core/db.
// Point the data dir at a temp dir BEFORE anything is imported, and replace core/db.js.
const h = vi.hoisted(() => {
  const dir = (process.env.FUNGIBLE_DATA_DIR = `${(process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/fungible-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { dir, log: [] as string[] };
});

vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());
vi.mock('../../../core/db.js', async () => ({
  db: await (await import('../../helpers/makeTestDb.js')).makeTestDb(),
  initDb: vi.fn(async () => { h.log.push('initDb'); }),
}));
vi.mock('../../../core/backup.js', () => ({ backupDb: vi.fn(async () => { h.log.push('backupDb'); }) }));
vi.mock('../../../core/rename.js', () => ({ rebuildDisplayNames: vi.fn(async () => {}) }));
vi.mock('../../../core/sync.js', () => ({ syncAll: vi.fn(async () => { h.log.push('syncAll'); return []; }) }));
vi.mock('../../../core/plaid.js', () => ({ plaidErrorMessage: vi.fn((e: any) => `plaid:${e?.message ?? e}`) }));
vi.mock('../../../scripts/seed-demo.js', () => ({ seedDemo: vi.fn(async () => { h.log.push('seedDemo'); }) }));
vi.mock('../../../gui/main/bridge.js', () => ({ registerBridge: vi.fn(() => { h.log.push('registerBridge'); }) }));
vi.mock('../../../gui/main/refresh-ipc.js', () => ({ registerRefreshPush: vi.fn(() => { h.log.push('registerRefreshPush'); }) }));
vi.mock('../../../gui/main/sync-status-ipc.js', () => ({ registerSyncStatusPush: vi.fn(() => { h.log.push('registerSyncStatusPush'); }) }));
vi.mock('../../../gui/main/sync-progress-ipc.js', () => ({ registerSyncProgressPush: vi.fn(() => { h.log.push('registerSyncProgressPush'); }) }));
vi.mock('../../../gui/main/agent-ipc.js', () => ({
  registerAgentIpc: vi.fn(() => { h.log.push('registerAgentIpc'); }),
  rejectPendingConfirms: vi.fn(),
}));
vi.mock('../../../gui/main/sync-ipc.js', () => ({ registerSyncIpc: vi.fn(() => { h.log.push('registerSyncIpc'); }) }));
vi.mock('../../../gui/main/plaid-link.js', () => ({ cancelActivePlaidLink: vi.fn(), runPlaidLink: vi.fn() }));
vi.mock('../../../gui/main/menu.js', () => ({
  // windows.length at call time proves the window is created AFTER the menu.
  buildMenu: vi.fn(() => { h.log.push(`buildMenu(windows=${electronMock.windows.length})`); }),
}));

const STATE = join(h.dir, 'gui-window.json');
const savedEnv = { ...process.env };
afterAll(() => rmSync(h.dir, { recursive: true, force: true }));

beforeEach(() => {
  electronMock.reset();
  vi.resetModules();
  h.log.length = 0;
  rmSync(h.dir, { recursive: true, force: true });
  require_dir();
  delete process.env.FUNGIBLE_DEMO;
  delete process.env.ELECTRON_RENDERER_URL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['FUNGIBLE_DEMO', 'ELECTRON_RENDERER_URL']) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

function require_dir() {
  mkdirSync(h.dir, { recursive: true });
}

/** Load a fresh copy of app.ts and fire app.whenReady. */
async function boot(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const mods = {
    db: await import('../../../core/db.js'),
    backup: await import('../../../core/backup.js'),
    rename: await import('../../../core/rename.js'),
    sync: await import('../../../core/sync.js'),
    seed: await import('../../../scripts/seed-demo.js'),
    agent: await import('../../../gui/main/agent-ipc.js'),
    plaidLink: await import('../../../gui/main/plaid-link.js'),
    progress: await import('../../../gui/main/sync-progress.js'),
    status: await import('../../../core/sync-status.js'),
    refresh: await import('../../../core/refresh.js'),
  };
  await import('../../../gui/main/app.js');
  await electronMock.app.flushReady();
  return mods;
}
const win = () => electronMock.windows[0];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('single-instance lock', () => {
  it('denied: quits and wires nothing (no whenReady work, no second-instance, no DB init)', async () => {
    electronMock.app.requestSingleInstanceLock.mockImplementation(() => false);
    const m = await boot();
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
    expect(m.db.initDb).not.toHaveBeenCalled();
    expect(electronMock.windows).toHaveLength(0);
    makeWindow();
    electronMock.app.emit('second-instance');
    expect(electronMock.windows[0].focus).not.toHaveBeenCalled();
    // window-all-closed is also not wired on the losing instance
    electronMock.app.emit('window-all-closed');
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });

  it('granted: second-instance restores a minimized window then focuses it', async () => {
    await boot();
    const w = win();
    w.minimized = true;
    electronMock.app.emit('second-instance');
    expect(w.restore).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
    expect(w.restore.mock.invocationCallOrder[0]).toBeLessThan(w.focus.mock.invocationCallOrder[0]);
  });

  it('granted: second-instance on a non-minimized window only focuses', async () => {
    await boot();
    const w = win();
    electronMock.app.emit('second-instance');
    expect(w.restore).not.toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalledTimes(1);
  });

  it('granted: second-instance with no windows does not throw', async () => {
    await boot();
    electronMock.windows.length = 0;
    expect(() => electronMock.app.emit('second-instance')).not.toThrow();
  });
});

describe('startup ordering and DB-init failure', () => {
  it('initDb completes before every register*, the menu and the window', async () => {
    await boot();
    expect(h.log.slice(0, 1)).toEqual(['initDb']);
    const order = h.log.filter((l) => l !== 'backupDb' && l !== 'syncAll');
    expect(order).toEqual([
      'initDb',
      'registerBridge',
      'registerRefreshPush',
      'registerSyncStatusPush',
      'registerSyncProgressPush',
      'registerAgentIpc',
      'registerSyncIpc',
      'buildMenu(windows=0)',
    ]);
    expect(electronMock.windows).toHaveLength(1);
    // the startup sync runs only once everything is wired
    expect(h.log.indexOf('syncAll')).toBeGreaterThan(h.log.indexOf('buildMenu(windows=0)'));
  });

  it('initDb rejecting shows the error box, quits, and wires/syncs nothing', async () => {
    const m = await import('../../../core/db.js');
    vi.mocked(m.initDb).mockRejectedValueOnce(new Error('disk is on fire'));
    await boot();
    expect(electronMock.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith('fungible — database error', 'disk is on fire');
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual([]);
    expect(electronMock.windows).toHaveLength(0);
  });

  it('a non-Error rejection is stringified', async () => {
    const m = await import('../../../core/db.js');
    vi.mocked(m.initDb).mockRejectedValueOnce('plain string failure');
    await boot();
    expect(electronMock.dialog.showErrorBox).toHaveBeenCalledWith('fungible — database error', 'plain string failure');
  });
});

describe('demo vs real startup', () => {
  it('demo: seeds, does not back up and never syncs (no Plaid against demo data)', async () => {
    await boot({ FUNGIBLE_DEMO: '1' });
    expect(h.log).toContain('seedDemo');
    expect(h.log).not.toContain('backupDb');
    expect(h.log).not.toContain('syncAll');
    expect(electronMock.windows).toHaveLength(1);
  });

  it('real: backs up and syncs once, never seeds', async () => {
    await boot();
    expect(h.log.filter((l) => l === 'backupDb')).toHaveLength(1);
    expect(h.log.filter((l) => l === 'syncAll')).toHaveLength(1);
    expect(h.log).not.toContain('seedDemo');
  });

  it('a backup failure is swallowed: window and sync still happen', async () => {
    const b = await import('../../../core/backup.js');
    vi.mocked(b.backupDb).mockRejectedValueOnce(new Error('no space'));
    await boot();
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(electronMock.windows).toHaveLength(1);
    expect(h.log).toContain('syncAll');
  });

  it('a display-name rebuild failure is logged but does not block the window', async () => {
    const r = await import('../../../core/rename.js');
    vi.mocked(r.rebuildDisplayNames).mockRejectedValueOnce(new Error('rebuild boom'));
    await boot();
    expect(electronMock.windows).toHaveLength(1);
    expect(electronMock.dialog.showErrorBox).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[gui] display-name rebuild failed:', expect.objectContaining({ message: 'rebuild boom' }));
  });
});

describe('background startup sync', () => {
  it('success: records the result, notifies the renderer once and ends the progress signal', async () => {
    const sync = await import('../../../core/sync.js');
    const results = [{ itemId: 'i1', added: 1, modified: 0, removed: 0, dupes: 0, skipped: false, error: 'bank down' }];
    vi.mocked(sync.syncAll).mockResolvedValueOnce(results as any);
    const refresh = await import('../../../core/refresh.js');
    const onChange = vi.fn();
    refresh.onRefresh(onChange);
    const progress = await import('../../../gui/main/sync-progress.js');
    const seen: boolean[] = [];
    progress.onSyncProgress((s) => seen.push(s));
    const status = await import('../../../core/sync-status.js');

    await boot();
    await flush();
    expect(status.getSyncFailures()).toEqual([{ itemId: 'i1', error: 'bank down' }]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true, false]);
    expect(progress.isSyncInProgress()).toBe(false);
  });

  it('sync is bracketed: progress is on while syncAll is in flight', async () => {
    const sync = await import('../../../core/sync.js');
    let release!: (v: any[]) => void;
    vi.mocked(sync.syncAll).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const progress = await import('../../../gui/main/sync-progress.js');
    await boot();
    expect(progress.isSyncInProgress()).toBe(true);
    release([]);
    await flush();
    expect(progress.isSyncInProgress()).toBe(false);
  });

  it('rejection: records exactly one itemId-less failure from plaidErrorMessage and still ends progress', async () => {
    const sync = await import('../../../core/sync.js');
    vi.mocked(sync.syncAll).mockRejectedValueOnce(new Error('ITEM_LOGIN_REQUIRED'));
    const progress = await import('../../../gui/main/sync-progress.js');
    const status = await import('../../../core/sync-status.js');
    await boot();
    await flush();
    expect(status.getSyncFailures()).toEqual([{ itemId: '', error: 'plaid:ITEM_LOGIN_REQUIRED' }]);
    expect(progress.isSyncInProgress()).toBe(false);
  });
});

describe('window creation', () => {
  it('locks down webPreferences and sets the size floor', async () => {
    await boot();
    const o = win().options;
    expect(o.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(o.webPreferences.preload.endsWith(`preload${sep}index.cjs`)).toBe(true);
    expect(o.minWidth).toBe(900);
    expect(o.minHeight).toBe(600);
  });

  it('window.open is denied and handed to the OS browser', async () => {
    await boot();
    const out = win().webContents.openHandler!({ url: 'https://example.com/x' });
    expect(out).toEqual({ action: 'deny' });
    expect(electronMock.shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/x');
  });

  it.each([
    'file:///etc/passwd',
    'smb://host/share',
    'javascript:alert(1)',
    'custom-app://do-thing',
    'mailto:a@b.com',
    'not a url',
    '',
  ])('refuses to open %j externally', async (url) => {
    await boot();
    const out = win().webContents.openHandler!({ url });
    expect(out).toEqual({ action: 'deny' });
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it('dev: ELECTRON_RENDERER_URL is loaded as a URL', async () => {
    await boot({ ELECTRON_RENDERER_URL: 'http://localhost:5173' });
    expect(win().loadURL).toHaveBeenCalledExactlyOnceWith('http://localhost:5173');
    expect(win().loadFile).not.toHaveBeenCalled();
  });

  it('prod: loads the bundled renderer index.html', async () => {
    await boot();
    expect(win().loadURL).not.toHaveBeenCalled();
    const f = vi.mocked(win().loadFile).mock.calls[0][0] as string;
    expect(f.endsWith(join('renderer', 'index.html'))).toBe(true);
  });

  it("'closed' rejects pending confirms and cancels an active Plaid link", async () => {
    const m = await boot();
    win().emit('closed');
    expect(m.agent.rejectPendingConfirms).toHaveBeenCalledTimes(1);
    expect(m.plaidLink.cancelActivePlaidLink).toHaveBeenCalledTimes(1);
  });
});

describe('window state persistence', () => {
  it('missing state file -> 1280x840 defaults, no position', async () => {
    await boot();
    expect(win().options).toMatchObject({ width: 1280, height: 840 });
    expect(win().options.x).toBeUndefined();
  });

  it('corrupt state file -> defaults', async () => {
    writeFileSync(STATE, '{not json');
    await boot();
    expect(win().options).toMatchObject({ width: 1280, height: 840 });
  });

  it('valid saved bounds are merged over defaults', async () => {
    writeFileSync(STATE, JSON.stringify({ width: 1000, x: 40, y: 50 }));
    await boot();
    expect(win().options).toMatchObject({ width: 1000, height: 840, x: 40, y: 50 });
  });

  it("'close' writes getNormalBounds() as JSON", async () => {
    await boot();
    win().bounds = { x: 5, y: 6, width: 1111, height: 777 };
    win().emit('close');
    expect(JSON.parse(readFileSync(STATE, 'utf-8'))).toEqual({ x: 5, y: 6, width: 1111, height: 777 });
  });

  it("a failing write on 'close' is swallowed", async () => {
    await boot();
    rmSync(h.dir, { recursive: true, force: true }); // dir gone -> writeFileSync throws ENOENT
    expect(() => win().emit('close')).not.toThrow();
    expect(existsSync(STATE)).toBe(false);
  });
});

describe('app lifecycle events', () => {
  // SMELL S6: quitting on every window-all-closed (also on macOS) means closing
  // the last window quits the app, so the macOS-style 'activate' re-open path
  // below is unreachable in practice outside the brief window before quit.
  it("'window-all-closed' quits the app", async () => {
    await boot();
    electronMock.app.quit.mockClear();
    electronMock.app.emit('window-all-closed');
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });

  it("'activate' with no windows creates one", async () => {
    await boot();
    electronMock.windows.length = 0;
    electronMock.app.emit('activate');
    expect(electronMock.windows).toHaveLength(1);
  });

  it("'activate' with a window already open does not create another", async () => {
    await boot();
    electronMock.app.emit('activate');
    expect(electronMock.windows).toHaveLength(1);
  });
});
