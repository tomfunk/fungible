import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// What this suite uniquely covers (the jsdom component tests can't): the real
// main-process boot path, electron-vite build-output wiring, native module
// loading (@libsql/* must load in the packaged main process — a broken binding
// would crash boot), the sandboxed-preload contextBridge, and the real
// ipcRenderer→ipcMain serialization in gui/main/bridge.ts. The jsdom tests stub
// window.__bridge entirely, so none of that is exercised there.

// Built main entry produced by `npm run gui:build` (electron-vite). The e2e npm
// script runs the build first; running `playwright test` without it will fail
// here with a missing-file error — that's the intended signal.
const MAIN_ENTRY = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));

// The contextBridge shape the preload exposes on the renderer's window.
type BridgeWindow = Window & {
  __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> };
};

let app: ElectronApplication;
let win: Page;
let dataDir: string;

test.beforeEach(async () => {
  // Isolate every on-disk side effect (DB, .env, gui-window.json, backups) in a
  // throwaway dir so the e2e run never reads or writes the developer's real
  // ~/.fungible data. We deliberately do NOT set FUNGIBLE_DEMO: gui/main/index.ts
  // redirects the data dir to ~/.fungible-demo whenever it is set, which would
  // defeat this isolation. An empty DB is enough — the schema is created on boot
  // and every screen still renders through the real bridge.
  dataDir = mkdtempSync(join(tmpdir(), 'fungible-e2e-'));
  app = await electron.launch({
    // --no-sandbox only on CI: GitHub's Linux runners don't ship the SUID
    // chrome-sandbox helper, so the renderer process can't spawn without it.
    // Local runs keep the sandbox (matching app.ts's webPreferences.sandbox).
    args: [MAIN_ENTRY, ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: { ...process.env, FUNGIBLE_DATA_DIR: dataDir },
  });
  win = await app.firstWindow();
  // Electron 44 (Chromium bump) surfaces the first window to Playwright earlier
  // in its lifecycle: firstWindow() now resolves on the window's initial
  // about:blank context, and the subsequent loadFile() navigation to
  // index.html destroys that context. One-shot calls (win.title(),
  // win.evaluate()) that run in the gap either see Chromium's transient
  // "Loading file://…" title or throw "Execution context was destroyed".
  // waitForFunction re-evaluates across navigations, so waiting for the
  // preload's contextBridge to land pins us to the real renderer context.
  // (The locator-based checks in screens.spec.ts retry on their own.)
  await win.waitForFunction(() => '__bridge' in window);
});

test.afterEach(async () => {
  await app?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('boots, opens exactly one window, and renders the Dashboard', async () => {
  // A window resolved from firstWindow() means the main process booted without
  // crashing (a DB/native-binding failure would dialog-and-quit before any window).
  expect(app.windows()).toHaveLength(1);

  // Renderer actually loaded its document.
  await expect.poll(() => win.title()).toBe('fungible');

  // A known screen rendered all the way through the bridge/IPC path. If any bridge
  // call had failed, useQuery re-throws and the ErrorBoundary would replace the
  // Dashboard heading with "Something went wrong loading this screen."
  await expect(win.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(win.getByText('Something went wrong')).toHaveCount(0);
});

test('completes a real bridge round-trip (preload contextBridge → main IPC → core/queries → DB)', async () => {
  // Exercise the exact wiring the jsdom tests stub out: the contextBridge exposed
  // in the sandboxed preload, ipcRenderer→ipcMain serialization in
  // gui/main/bridge.ts, and a live core/queries call against the real (empty) DB.
  const result = await win.evaluate(() =>
    (window as unknown as BridgeWindow).__bridge.call('queries', 'getAccountsWithBalances', []),
  );

  // getAccountsWithBalances() returns { accounts, history }; an empty DB yields
  // empty arrays. Getting a well-formed, serialized object back over IPC proves
  // the round-trip end to end.
  expect(result).toMatchObject({ accounts: [], history: [] });
});
