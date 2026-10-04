import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Seeded read + write round-trip through the REAL app (main process, preload,
// registry, core, SQLite). Unlike screens.spec.ts (which only checks that a
// screen renders without an error boundary), these tests assert exact seeded
// values on screen, and that a UI write is actually persisted in the DB file.
// Each test gets its own throwaway data dir seeded with the "fixture" dataset
// from seed-db.ts, so tests are independent and order-free.

const MAIN_ENTRY = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));
const SEED_SCRIPT = fileURLToPath(new URL('./seed-db.ts', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let app: ElectronApplication;
let win: Page;
let dataDir: string;

/** Open the temp DB read-only-by-convention from the spec process and run a query. */
async function queryDb(sql: string, args: (string | number)[] = []) {
  const client = createClient({ url: `file:${join(dataDir, 'fungible.db')}` });
  try {
    return (await client.execute({ sql, args })).rows;
  } finally {
    client.close();
  }
}

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fungible-e2e-seeded-'));
  // Safety: the app must never be pointed at the developer's real data. The dir
  // was just created under the OS temp dir; refuse to continue otherwise.
  if (!resolve(dataDir).startsWith(resolve(tmpdir()) + sep)) {
    throw new Error(`refusing to run e2e outside the temp dir: ${dataDir}`);
  }
  // Never let an inherited demo flag redirect the app to ~/.fungible-demo.
  const { FUNGIBLE_DEMO: _demo, ...inherited } = process.env as Record<string, string>;
  const env = { ...inherited, FUNGIBLE_DATA_DIR: dataDir };
  execFileSync(process.execPath, ['--import', 'tsx/esm', SEED_SCRIPT, 'fixture'], {
    cwd: PROJECT_ROOT,
    env,
  });
  app = await electron.launch({
    args: [MAIN_ENTRY, ...(process.env.CI ? ['--no-sandbox'] : [])],
    env,
  });
  win = await app.firstWindow();
  await win.waitForFunction(() => '__bridge' in window);
});

test.afterEach(async () => {
  await app?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function goTo(nav: string, heading: string) {
  await win.getByRole('button', { name: nav, exact: true }).click();
  await expect(win.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test('Dashboard shows the seeded month totals', async () => {
  // Expenses this month: 87.43 + 12.34 + 45.67 = 145.44; income 2,500.00.
  await expect(win.getByText('$2,500.00').first()).toBeVisible();
  await expect(win.getByText('$145.44').first()).toBeVisible();
  await expect(win.getByText('Food & Drink').first()).toBeVisible();
});

test('Transactions lists seeded rows with their exact amounts', async () => {
  await goTo('Transactions', 'Transactions');
  await expect(win.getByText('4 transactions')).toBeVisible();
  // Outflows render negative, inflows positive (fmtTxAmount flips the Plaid sign).
  await expect(win.getByRole('row', { name: /Quokka Market/ })).toContainText('-$87.43');
  await expect(win.getByRole('row', { name: /Zebra Cafe/ })).toContainText('-$12.34');
  await expect(win.getByRole('row', { name: /Okapi Payroll/ })).toContainText('+$2,500.00');
  await expect(win.getByRole('row', { name: /Mystery Vendor/ })).toContainText('Uncategorized');
});

test('Net Worth shows seeded balances, totals and the net figure', async () => {
  await goTo('Net Worth', 'Net Worth');
  await expect(win.getByRole('row', { name: /Fixture Checking/ })).toContainText('$5,000.00');
  await expect(win.getByRole('row', { name: /Fixture Visa/ })).toContainText('$1,250.00');
  // 5,000 assets - 1,250 debt
  await expect(win.getByText('+$3,750.00').first()).toBeVisible();
});

test('categorising a transaction in the UI persists to the database', async () => {
  await goTo('Transactions', 'Transactions');
  const before = await queryDb(`SELECT category, manual_category FROM transactions WHERE id = 'fx-t4'`);
  expect(before[0]).toMatchObject({ category: 'Uncategorized' });

  await win.getByRole('row', { name: /Mystery Vendor/ }).click();
  await win.locator('label:text-is("Category") + select').selectOption('Shopping');
  await win.getByRole('button', { name: 'Save', exact: true }).click();
  // A manual recategorise offers to turn it into a rule; decline so only this row changes.
  await win.getByRole('button', { name: 'No, just this once' }).click();

  // UI reflects it...
  await expect(win.getByRole('row', { name: /Mystery Vendor/ })).toContainText('Shopping');
  // ...and so does the file on disk, pinned as a manual category.
  await expect
    .poll(async () => (await queryDb(`SELECT category, manual_category FROM transactions WHERE id = 'fx-t4'`))[0])
    .toMatchObject({ category: 'Shopping', manual_category: 'Shopping' });

  // A fresh read through the app (screen remount) still shows it.
  await goTo('Accounts', 'Accounts');
  await goTo('Transactions', 'Transactions');
  await expect(win.getByRole('row', { name: /Mystery Vendor/ })).toContainText('Shopping');
});

test('adding a manual transaction persists with the right sign and source', async () => {
  await goTo('Transactions', 'Transactions');
  await win.getByRole('button', { name: '+ Add' }).click();
  await win.getByPlaceholder('e.g. Corner Store').fill('Pangolin Hardware');
  await win.getByPlaceholder('0.00').fill('33.21');
  await win.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(win.getByRole('row', { name: /Pangolin Hardware/ })).toContainText('-$33.21');
  await expect
    .poll(async () => (await queryDb(`SELECT amount, source FROM transactions WHERE name = 'Pangolin Hardware'`))[0])
    .toMatchObject({ amount: 33.21, source: 'manual' });
  // Adding a transaction must not touch the bank-reported balance history.
  expect(await queryDb(`SELECT COUNT(*) AS c FROM balance_history`)).toMatchObject([{ c: 2 }]);
});
