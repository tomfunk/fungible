/**
 * Fake `electron` module for tests of gui/main/*.ts.
 *
 * Usage (from a test under tests/gui/main/):
 *
 *   import { vi } from 'vitest';
 *   import { electronMock, makeEvent, makeWindow } from '../../helpers/makeElectronMock.js';
 *   vi.mock('electron', async () => (await import('../../helpers/makeElectronMock.js')).electronModule());
 *   beforeEach(() => electronMock.reset());
 *
 *   const { registerRefreshPush } = await import('../../../gui/main/refresh-ipc.js');
 *   const out = await electronMock.invoke('bridge:call', 'ns', 'fn', []);
 *
 * DATA SAFETY: any test that imports gui/main/registry, bridge or app pulls in
 * core/db.js, which opens the REAL ~/.fungible database. Such a test MUST also
 * `vi.mock('../../../core/db.js', ...)` with a makeTestDb() in-memory db (see
 * tests/helpers/makeTestDb.ts) before importing those modules.
 *
 * The singleton `electronMock` is shared between the test file and the mocked
 * module, and survives `vi.resetModules()`: it is stashed on globalThis, so a
 * re-evaluated copy of this file reuses the same instance (no priming
 * `await import('electron')` workaround needed). Note FakeBrowserWindow class
 * identity is per module copy, but the window list it pushes to is shared.
 */
import { vi } from 'vitest';

type Fn = (...args: any[]) => any;

export interface FakeSender {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  destroyed: boolean;
}
export interface FakeEvent {
  sender: FakeSender;
}

export function makeEvent(opts: { destroyed?: boolean } = {}): FakeEvent {
  const sender: FakeSender = {
    destroyed: !!opts.destroyed,
    send: vi.fn(),
    isDestroyed: () => sender.destroyed,
  };
  return { sender };
}

function emitter() {
  const listeners = new Map<string, Fn[]>();
  return {
    on(evt: string, fn: Fn) {
      listeners.set(evt, [...(listeners.get(evt) ?? []), fn]);
    },
    emit(evt: string, ...args: unknown[]) {
      for (const fn of listeners.get(evt) ?? []) fn(...args);
    },
    clear() {
      listeners.clear();
    },
  };
}

export class FakeBrowserWindow {
  static getAllWindows() {
    return electronMock.windows;
  }
  options: any;
  private ev = emitter();
  webContents = {
    send: vi.fn(),
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    openHandler: undefined as undefined | ((d: { url: string }) => unknown),
    setWindowOpenHandler(fn: (d: { url: string }) => unknown) {
      this.openHandler = fn;
    },
  };
  minimized = false;
  bounds = { x: 0, y: 0, width: 1280, height: 840 };
  loadedURL?: string;
  loadedFile?: string;
  focused = false;
  constructor(options: unknown = {}) {
    this.options = options;
    electronMock.windows.push(this);
  }
  on(evt: string, fn: Fn) {
    this.ev.on(evt, fn);
    return this;
  }
  /** Fire a window event ('close', 'closed', ...). 'closed' also drops the window. */
  emit(evt: string, ...args: unknown[]) {
    this.ev.emit(evt, ...args);
    if (evt === 'closed') {
      const i = electronMock.windows.indexOf(this);
      if (i >= 0) electronMock.windows.splice(i, 1);
    }
  }
  loadURL = vi.fn(async (url: string) => {
    this.loadedURL = url;
  });
  loadFile = vi.fn(async (f: string) => {
    this.loadedFile = f;
  });
  isMinimized() {
    return this.minimized;
  }
  restore = vi.fn(() => {
    this.minimized = false;
  });
  focus = vi.fn(() => {
    this.focused = true;
  });
  getNormalBounds() {
    return this.bounds;
  }
}

/** A window registered in electronMock.windows (same as `new BrowserWindow()`). */
export function makeWindow(options: unknown = {}): FakeBrowserWindow {
  return new FakeBrowserWindow(options);
}

export class FakeRequest {
  headers: Record<string, string> = {};
  ended = false;
  private ev = emitter();
  constructor(public opts: unknown) {
    electronMock.requests.push(this);
  }
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  on(evt: string, fn: Fn) {
    this.ev.on(evt, fn);
    return this;
  }
  end() {
    this.ended = true;
  }
  /**
   * Deliver a response. `body` is a string (UTF-8) or Buffer; `chunks`
   * (default 1) splits the encoded BYTES evenly, so multibyte characters can
   * straddle chunk boundaries. Emits response -> data* -> end.
   */
  respond(statusCode: number, body: string | Buffer = '', chunks = 1) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const res = emitter();
    this.ev.emit('response', { statusCode, on: res.on.bind(res) });
    const size = Math.max(1, Math.ceil(buf.length / Math.max(1, chunks)));
    for (let i = 0; i < buf.length; i += size) res.emit('data', buf.subarray(i, i + size));
    res.emit('end');
  }
  /** Fire a request-level 'error'. */
  fail(err: Error) {
    this.ev.emit('error', err);
  }
}

function makeApp() {
  const ev = emitter();
  let resolveReady!: () => void;
  let ready = new Promise<void>((r) => (resolveReady = r));
  return {
    name: 'fungible',
    getVersion: vi.fn(() => '1.0.0'),
    getAppPath: vi.fn(() => '/fake/app'),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    relaunch: vi.fn(),
    on: (evt: string, fn: Fn) => ev.on(evt, fn),
    /** Fire an app event, e.g. emit('second-instance'), emit('window-all-closed'). */
    emit: (evt: string, ...args: unknown[]) => ev.emit(evt, ...args),
    whenReady: () => ready,
    /** Resolve app.whenReady() and let its .then callbacks run. */
    flushReady: async () => {
      resolveReady();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
    _reset() {
      ev.clear();
      ready = new Promise<void>((r) => (resolveReady = r));
    },
  };
}

const freshElectronMock = {
  handlers: new Map<string, Fn>(),
  windows: [] as FakeBrowserWindow[],
  requests: [] as FakeRequest[],
  app: makeApp(),
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async (..._a: unknown[]): Promise<any> => ({ response: 0 })),
    showOpenDialog: vi.fn(async (..._a: unknown[]): Promise<any> => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async (..._a: unknown[]): Promise<any> => ({ canceled: true, filePath: undefined })),
  },
  shell: { openExternal: vi.fn(async (..._a: unknown[]) => {}) },
  Menu: {
    buildFromTemplate: vi.fn((t: unknown) => t),
    setApplicationMenu: vi.fn(),
  },
  /** Restore pristine state; call in beforeEach. */
  reset() {
    this.handlers.clear();
    this.windows.length = 0;
    this.requests.length = 0;
    this.app._reset();
    const a = this.app;
    const d = this.dialog;
    for (const m of [
      a.getVersion, a.getAppPath, a.requestSingleInstanceLock, a.quit, a.relaunch,
      d.showErrorBox, d.showMessageBox, d.showOpenDialog, d.showSaveDialog,
      this.shell.openExternal, this.Menu.setApplicationMenu,
    ]) m.mockClear();
    a.requestSingleInstanceLock.mockImplementation(() => true);
    a.getVersion.mockImplementation(() => '1.0.0');
    d.showMessageBox.mockImplementation(async () => ({ response: 0 }));
    d.showOpenDialog.mockImplementation(async () => ({ canceled: true, filePaths: [] }));
    d.showSaveDialog.mockImplementation(async () => ({ canceled: true, filePath: undefined }));
  },
  /** Call a handler registered via ipcMain.handle, as the renderer would. */
  async invoke(channel: string, ...args: unknown[]) {
    return this.invokeWith(makeEvent(), channel, ...args);
  },
  /** Same, with an explicit event (e.g. makeEvent({ destroyed: true })). */
  async invokeWith(event: FakeEvent, channel: string, ...args: unknown[]) {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`No ipcMain handler registered for '${channel}'`);
    return h(event, ...args);
  },
};

/**
 * resetModules-safe singleton. `vi.resetModules()` re-evaluates this file the
 * next time it is imported dynamically (e.g. through the vi.mock factory), which
 * would otherwise create a SECOND electronMock: windows/handlers the test
 * registers on its statically imported instance would be invisible to the code
 * under test. Stashing it on globalThis makes every copy of this module share one.
 */
const KEY = '__fungibleElectronMock';
export const electronMock: typeof freshElectronMock = ((globalThis as any)[KEY] ??= freshElectronMock);

/** The object to return from the vi.mock('electron') factory. */
export function electronModule() {
  const m = {
    ipcMain: {
      handle: (ch: string, fn: Fn) => {
        electronMock.handlers.set(ch, fn);
      },
      on: (ch: string, fn: Fn) => {
        electronMock.handlers.set(ch, fn);
      },
      removeHandler: (ch: string) => {
        electronMock.handlers.delete(ch);
      },
    },
    BrowserWindow: FakeBrowserWindow,
    app: electronMock.app,
    dialog: electronMock.dialog,
    shell: electronMock.shell,
    Menu: electronMock.Menu,
    net: { request: (opts: unknown) => new FakeRequest(opts) },
  };
  return { ...m, default: m };
}
