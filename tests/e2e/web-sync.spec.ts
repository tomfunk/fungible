// Browser web app against a live sync server. Skipped unless FUNGIBLE_SYNC_TEST_URL is
// set (e.g. http://localhost:3000), so CI without a backend is unaffected, and
// skipped (not failed) while the server's operation-log routes (POST /sync/ops)
// are not deployed yet. OPFS behaviour that needs no backend lives in
// web-opfs.spec.ts.
//
// Serves web/ with a throwaway Vite dev server on its own port. The sync server's CORS
// allow-list names one origin, so responses from the backend get the test
// origin injected at the network layer instead of requiring it be allowed.
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const SYNC_SERVER = process.env.FUNGIBLE_SYNC_TEST_URL;
const PORT = 5391;
const ORIGIN = `http://localhost:${PORT}`;

test.skip(!SYNC_SERVER, 'FUNGIBLE_SYNC_TEST_URL not set');
test.describe.configure({ mode: 'serial' });

let opsDeployed = true;

let server: ChildProcess;
let browser: Browser;

test.beforeAll(async () => {
  server = spawn('npx', ['vite', 'web', '--port', String(PORT), '--strictPort'], {
    env: { ...process.env, VITE_FUNGIBLE_SYNC_URL: SYNC_SERVER },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(ORIGIN)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
  if (SYNC_SERVER) {
    // An unauthenticated POST answers 401 where the route exists and 404 where it does not.
    const probe = await fetch(`${SYNC_SERVER}/sync/ops`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).catch(() => null);
    opsDeployed = probe != null && probe.status !== 404;
  }
});

test.beforeEach(() => {
  test.skip(!opsDeployed, 'server has no POST /sync/ops yet');
});

test.afterAll(async () => {
  await browser?.close();
  server?.kill();
});

async function newContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route(`${SYNC_SERVER}/**`, async (route) => {
    const h = {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    const r = await route.fetch();
    await route.fulfill({ response: r, headers: { ...r.headers(), ...h } });
  });
  return ctx;
}

type Rec = Record<string, unknown>;
const call = <T = unknown>(p: Page, ns: string, fn: string, ...args: unknown[]) =>
  p.evaluate(([n, f, a]) => (window as unknown as { __bridge: { call(n: string, f: string, a: unknown[]): Promise<unknown> } })
    .__bridge.call(n as string, f as string, a as unknown[]), [ns, fn, args] as const) as Promise<T>;

const PASSWORD = 'correct-horse-1';

/** Connect through the shared bridge call the Settings panel uses. */
async function connect(p: Page, email: string, createAccount: boolean) {
  await p.goto(ORIGIN + '/');
  await p.getByText('Dashboard').first().waitFor();
  const r = await call<{ status: string }>(p, 'account', 'connect', email, PASSWORD, { createAccount });
  expect(r.status).toBe('connected');
}

const rule = { matchType: 'name', minAmount: null, maxAmount: null, category: 'Groceries' };
type Cycle = { rejected: number; superseded: number };
type Info = { pendingCount: number; rejectedCount: number };
const names = async (p: Page) => (await call<Rec[]>(p, 'queries', 'getAllTags')).map((t) => t.name);

test('a fresh browser starts local-only: shell renders and /auth/refresh is never called', async () => {
  const ctx = await newContext();
  const p = await ctx.newPage();
  const refresh: string[] = [];
  p.on('request', (r) => { if (r.url().includes('/auth/refresh')) refresh.push(r.url()); });
  await p.goto(ORIGIN + '/');
  await p.getByText('Dashboard').first().waitFor();
  expect(refresh).toEqual([]);
  expect(await call(p, 'account', 'getSyncState')).toMatchObject({ platform: 'web', mode: 'byok', signedIn: false });
  await ctx.close();
});

test('the connect form in Settings signs in and shows the account', async () => {
  const ctx = await newContext();
  const p = await ctx.newPage();
  await p.goto(ORIGIN + '/');
  await p.getByText('Dashboard').first().waitFor();
  await p.getByRole('button', { name: /Settings/ }).first().click();
  await expect(p.getByText('Syncing sends your data to your account on the server.')).toBeVisible();
  await p.fill('#sync-email', `e2e-ui-${Date.now()}@example.test`);
  await p.fill('#sync-password', PASSWORD);
  await p.getByRole('button', { name: 'Connect with a new account' }).click();
  await expect(p.getByText(/Synced via account: e2e-ui-/)).toBeVisible();
  await expect(p.getByText('Configuration')).toHaveCount(0); // desktop-only panel
  await ctx.close();
});

test('the session survives a reload (cookie refresh) and the data persists without a pull', async () => {
  const ctx = await newContext();
  const p = await ctx.newPage();
  await connect(p, `e2e-${Date.now()}@example.test`, true);
  await call(p, 'tags', 'createTag', 'persisted');

  await ctx.route('**/sync/**', (r) => r.abort());
  await p.reload();
  await p.getByText('Dashboard').first().waitFor();
  expect(await names(p)).toContain('persisted');
  expect(await call(p, 'account', 'getSyncState')).toMatchObject({ mode: 'hosted', signedIn: true });
  await ctx.close();
});

test('rule and tag sync between two browsers; a concurrent edit is merged', async () => {
  const email = `e2e-x-${Date.now()}@example.test`;
  const a = await (await newContext()).newPage();
  const b = await (await newContext()).newPage();
  await connect(a, email, true);
  await connect(b, email, false);

  await call(a, 'tags', 'createTag', 'shared');
  await call(a, 'rules', 'saveCategoryRule', { ...rule, pattern: 'TRADER' });
  await call(a, 'account', 'syncNow');
  await call(b, 'account', 'syncNow');
  expect(await names(b)).toContain('shared');
  const bRules = await call<Rec[]>(b, 'rules', 'getAllRules');
  expect(bRules.map((r) => r.pattern)).toContain('TRADER');

  const aRule = (await call<Rec[]>(a, 'rules', 'getAllRules')).find((r) => r.pattern === 'TRADER')!;
  const bRule = bRules.find((r) => r.pattern === 'TRADER')!;
  await call(a, 'rules', 'saveCategoryRule', { ...rule, pattern: 'TRADER', category: 'Dining', editingId: aRule.id });
  await call(b, 'rules', 'saveCategoryRule', { ...rule, pattern: 'TRADER', category: 'Travel', editingId: bRule.id });
  await call(a, 'account', 'syncNow');
  await call<Cycle>(b, 'account', 'syncNow');

  // Settle: both converge on one value (last writer wins by field).
  await call(b, 'account', 'syncNow');
  await call(a, 'account', 'syncNow');
  const finalA = (await call<Rec[]>(a, 'rules', 'getAllRules')).find((r) => r.pattern === 'TRADER')!;
  const finalB = (await call<Rec[]>(b, 'rules', 'getAllRules')).find((r) => r.pattern === 'TRADER')!;
  expect(finalA.category).toBe(finalB.category);
});

test('two different accounts, each on a fresh browser, sync with nothing rejected or pending', async () => {
  for (const tag of ['first', 'second']) {
    const p = await (await newContext()).newPage();
    await connect(p, `e2e-${tag}-${Date.now()}@example.test`, true);
    const cycle = await call<Cycle>(p, 'account', 'syncNow');
    expect(cycle.rejected).toBe(0);
    const info = await call<Info>(p, 'sync', 'getInfo');
    expect(info.pendingCount).toBe(0);
    expect(info.rejectedCount).toBe(0);
    await p.context().close();
  }
});

test('plain sign out keeps the data; sign out and erase wipes it and signing back in re-pulls', async () => {
  const email = `e2e-wipe-${Date.now()}@example.test`;
  const ctx = await newContext();
  const p = await ctx.newPage();
  await connect(p, email, true);
  await call(p, 'tags', 'createTag', 'wipe-me');
  await call(p, 'account', 'syncNow');

  await call(p, 'account', 'disconnect');
  expect(await names(p)).toContain('wipe-me');
  expect(await call(p, 'account', 'getSyncState')).toMatchObject({ mode: 'byok', signedIn: false });

  const r = await call<{ status: string }>(p, 'account', 'connect', email, PASSWORD, {});
  expect(r.status).toBe('connected');
  expect(await call(p, 'account', 'signOutAndErase')).toEqual({ erased: true });
  await p.reload();
  await p.getByText('Dashboard').first().waitFor();
  expect(await names(p)).toEqual([]);

  expect((await call<{ status: string }>(p, 'account', 'connect', email, PASSWORD, {})).status).toBe('connected');
  expect(await names(p)).toContain('wipe-me');
  await ctx.close();
});
