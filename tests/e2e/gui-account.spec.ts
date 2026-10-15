import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Desktop account/sync gating through the real main process and IPC. Every run
// uses a throwaway data dir; the developer's ~/.fungible is never touched.
const MAIN_ENTRY = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));

type BridgeWindow = Window & {
  __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> };
};

let app: ElectronApplication | undefined;
let dataDir: string;

async function launch(env: Record<string, string | undefined>): Promise<Page> {
  dataDir = mkdtempSync(join(tmpdir(), 'fungible-e2e-acct-'));
  const base = { ...process.env, FUNGIBLE_DATA_DIR: dataDir } as Record<string, string | undefined>;
  delete base.FUNGIBLE_SYNC_URL;
  app = await electron.launch({
    args: [MAIN_ENTRY, ...(process.env.CI ? ['--no-sandbox'] : [])],
    env: { ...base, ...env } as Record<string, string>,
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => '__bridge' in window);
  return win;
}

const call = (win: Page, ns: string, fn: string, ...args: unknown[]) =>
  win.evaluate(([n, f, a]) => (window as unknown as BridgeWindow).__bridge.call(n as string, f as string, a as unknown[]),
    [ns, fn, args] as const);

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

test('without FUNGIBLE_SYNC_URL the desktop app is plain BYOK: no sync state, no Account section', async () => {
  const win = await launch({});
  expect(await call(win, 'account', 'getSyncState')).toBeNull();
  await win.getByRole('button', { name: /Settings/ }).first().click().catch(() => undefined);
  await expect(win.getByText('Configuration')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Account' })).toHaveCount(0);
});

test.describe('with a live backend', () => {
  test.skip(!process.env.FUNGIBLE_SYNC_TEST_URL, 'FUNGIBLE_SYNC_TEST_URL not set');
  test.beforeAll(async () => {
    // 401 where the route exists, 404 where the server side is not deployed yet.
    const probe = await fetch(`${process.env.FUNGIBLE_SYNC_TEST_URL}/sync/ops`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).catch(() => null);
    test.skip(probe == null || probe.status === 404, 'server has no POST /sync/ops yet');
  });

  test('connect registers, binds the install, and syncs with nothing rejected', async () => {
    const win = await launch({ FUNGIBLE_SYNC_URL: process.env.FUNGIBLE_SYNC_TEST_URL });
    const before = (await call(win, 'account', 'getSyncState')) as { mode: string };
    expect(before.mode).toBe('byok');

    const email = `e2e-desktop-${Date.now()}@example.test`;
    const res = (await call(win, 'account', 'connect', email, 'correct-horse-1', { createAccount: true })) as {
      status: string; summary?: { rejected: number };
    };
    expect(res.status).toBe('connected');
    expect(res.summary?.rejected).toBe(0);

    const after = (await call(win, 'account', 'getSyncState')) as {
      mode: string; email: string; pendingCount: number; rejectedCount: number;
    };
    expect(after).toMatchObject({ mode: 'hosted', email, pendingCount: 0, rejectedCount: 0 });

    await call(win, 'account', 'disconnect');
    expect(((await call(win, 'account', 'getSyncState')) as { mode: string }).mode).toBe('byok');
  });
});
