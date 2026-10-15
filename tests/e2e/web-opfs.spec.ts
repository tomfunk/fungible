// Real-browser check of the web app's local database (OPFS) with no backend:
// data persists across reload, and a second tab is told the app is open
// elsewhere instead of getting its own copy. Serves web/ with a throwaway Vite
// dev server on its own port.
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 5392;
const ORIGIN = `http://localhost:${PORT}`;

test.describe.configure({ mode: 'serial' });

let server: ChildProcess;
let browser: Browser;

test.beforeAll(async () => {
  server = spawn('npx', ['vite', 'web', '--port', String(PORT), '--strictPort'], {
    // Nothing here ever needs a backend; point at a dead port so any stray call fails fast.
    env: { ...process.env, VITE_FUNGIBLE_SYNC_URL: 'http://127.0.0.1:59999' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(ORIGIN)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

const call = <T = unknown>(p: Page, ns: string, fn: string, ...args: unknown[]) =>
  p.evaluate(([n, f, a]) => (window as unknown as { __bridge: { call(n: string, f: string, a: unknown[]): Promise<unknown> } })
    .__bridge.call(n as string, f as string, a as unknown[]), [ns, fn, args] as const) as Promise<T>;

test('local-only: data persists across reload and a second tab gets the open-elsewhere screen', async () => {
  const ctx = await browser.newContext();
  const requests: string[] = [];
  ctx.on('request', (r) => { if (r.url().includes('127.0.0.1:59999')) requests.push(r.url()); });
  const p = await ctx.newPage();
  await p.goto(ORIGIN + '/');
  await p.getByText('Dashboard').first().waitFor();

  expect(await call(p, 'app', 'isPersistent')).toBe(true);
  expect(await call(p, 'account', 'getSyncState')).toMatchObject({ mode: 'byok', signedIn: false, persistent: true });
  await call(p, 'tags', 'createTag', 'persisted');

  await p.reload();
  await p.getByText('Dashboard').first().waitFor();
  const tags = await call<{ name: string }[]>(p, 'queries', 'getAllTags');
  expect(tags.map((t) => t.name)).toContain('persisted');

  const second = await ctx.newPage();
  await second.goto(ORIGIN + '/');
  await expect(second.getByText('fungible is open in another tab')).toBeVisible();

  // The first tab was not disturbed, and nothing went to the network.
  expect((await call<{ name: string }[]>(p, 'queries', 'getAllTags')).map((t) => t.name)).toContain('persisted');
  expect(requests).toEqual([]);
  await ctx.close();
});

test('closing the first tab frees the database for the next one, data intact', async () => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await a.goto(ORIGIN + '/');
  await a.getByText('Dashboard').first().waitFor();
  await call(a, 'tags', 'createTag', 'survives-close');
  await a.close();

  const b = await ctx.newPage();
  await b.goto(ORIGIN + '/');
  await b.getByText('Dashboard').first().waitFor();
  const tags = await call<{ name: string }[]>(b, 'queries', 'getAllTags');
  expect(tags.map((t) => t.name)).toContain('survives-close');
  await ctx.close();
});
