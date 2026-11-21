import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { waitFor as baseWaitFor, flatFrame } from '../helpers/waitFor.js';
import { useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAccounts, tabTo } from './helpers/accountsScreen.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });

useSeededScreenDb();

const URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';
const GOOD = 'ID,Date,Description,Amount\n1,2026-05-02,Babysitter,40\n2,2026-05-09,Babysitter,60\n';
const NO_DESCRIPTION = 'ID,Date,Amount\n1,2026-05-02,40\n';

/** Serves `body` as the published sheet for every fetch until changed. */
let body = GOOD;
let delayMs = 0;
const fetchMock = vi.fn(async () => {
  if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  return new Response(body, { headers: { 'content-type': 'text/csv' } });
});

beforeEach(() => {
  body = GOOD;
  delayMs = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const pause = (ms = 60) => new Promise((res) => setTimeout(res, ms));
const count = async (sql: string) => Number((await db.execute(sql)).rows[0].n);

async function startSheetFlow(r: ReturnType<typeof renderAccounts>) {
  await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
  await tabTo(r, 'add-data');
  expect(flatFrame(r)).toContain('[g] Google Sheet');
  r.stdin.write('g');
  await waitFor(() => expect(flatFrame(r)).toContain('Google Sheet — Account name'));
  r.stdin.write('Cash (Pat)');
  await waitFor(() => expect(flatFrame(r)).toContain('Cash (Pat)'));
  r.stdin.write('\r');
  await waitFor(() => expect(flatFrame(r)).toContain('Published CSV link'));
  r.stdin.write(URL);
  await waitFor(() => expect(flatFrame(r)).toContain('2PACX-abc'));
}

describe('Accounts: Google Sheet account', () => {
  it('checks the headers before adding, says what to add, and adds once the sheet is fixed', async () => {
    body = NO_DESCRIPTION;
    const r = renderAccounts();
    await startSheetFlow(r);
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain(
      "The sheet's first row is missing Description. Add a header row with ID, Date, Description and Amount (Category is optional), then try again.",
    ));
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE name = 'Cash (Pat)'")).toBe(0);
    expect(flatFrame(r)).toContain('Published CSV link'); // still on the link, ready to retry

    body = GOOD;
    r.stdin.write('\r');
    await waitFor(() => {
      const f = flatFrame(r);
      expect(f).toContain('Account added');
      expect(f).toContain('Synced — 2 new');
    });
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE name = 'Cash (Pat)' AND excluded = 1")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE dedup_key LIKE 'sheet:%'")).toBe(2);

    r.stdin.write('\r'); // back to the account list, which names the sheet
    await waitFor(() => {
      const f = flatFrame(r);
      expect(f).toContain('Cash (Pat)');
      expect(f).toContain('Google Sheet');
      expect(f).toContain('synced');
    });
  });

  it('adds one account when Enter is pressed again while the sheet is being checked', async () => {
    delayMs = 150;
    const r = renderAccounts();
    await startSheetFlow(r);
    r.stdin.write('\r');
    await pause(20);
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain('Account added'));
    expect(await count("SELECT COUNT(*) AS n FROM accounts WHERE name = 'Cash (Pat)'")).toBe(1);
  });
});

describe('Accounts: Sheet link field', () => {
  async function openSheetField(r: ReturnType<typeof renderAccounts>) {
    await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain('Edit: Test Checking'));
    expect(flatFrame(r)).toContain('Sheet link');
    // Nickname → Type → Subtype → Net worth → Sheet link
    for (let i = 0; i < 4; i++) { r.stdin.write('\x1b[B'); await pause(10); }
    await waitFor(() => expect(flatFrame(r)).toContain('source of truth for this account'));
  }

  it('keeps the panel open on a sheet that fails the check, then links and syncs a good one', async () => {
    body = NO_DESCRIPTION;
    const r = renderAccounts();
    await openSheetField(r);
    r.stdin.write(URL);
    await pause();
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain('missing Description. Add a header row'));
    expect(flatFrame(r)).toContain('Edit: Test Checking');
    expect(await count('SELECT COUNT(*) AS n FROM sheet_sources')).toBe(0);

    body = GOOD;
    r.stdin.write('\r');
    // The account's own institution (Test Bank) still names it; the sync time is the sheet's.
    await waitFor(() => {
      const f = flatFrame(r);
      expect(f).not.toContain('Edit: Test Checking');
      expect(f).toContain('Test Checking ···0001 checking Test Bank synced just now');
    });
    await waitFor(async () => expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'test-checking' AND dedup_key LIKE 'sheet:%'")).toBe(2));
  });

  it('Ctrl+U clears the link, and saving unlinks without touching transactions', async () => {
    await db.execute({ sql: "INSERT INTO sheet_sources (account_id, url) VALUES ('test-checking', ?)", args: [URL] });
    const before = await count("SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'test-checking'");
    const r = renderAccounts();
    await openSheetField(r);
    expect(flatFrame(r)).toContain('2PACX-abc');
    r.stdin.write('\x15'); // Ctrl+U
    await waitFor(() => expect(flatFrame(r)).not.toContain('2PACX-abc'));
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).not.toContain('Edit: Test Checking'));
    await waitFor(async () => expect(await count('SELECT COUNT(*) AS n FROM sheet_sources')).toBe(0));
    expect(await count("SELECT COUNT(*) AS n FROM transactions WHERE account_id = 'test-checking'")).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a sheet's last error on its row and in the panel", async () => {
    await db.execute({
      sql: "INSERT INTO sheet_sources (account_id, url, last_synced_at, last_error) VALUES ('test-checking', ?, 1, 'Skipped 1 row: row 4 (unreadable date)')",
      args: [URL],
    });
    const r = renderAccounts();
    await waitFor(() => expect(flatFrame(r)).toContain('⚠ check its sheet'));
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain('Last sync: Skipped 1 row: row 4 (unreadable date)'));
  });

  it('has no Sheet link on a bank-linked account', async () => {
    await db.execute("UPDATE accounts SET item_id = 'item-1' WHERE id = 'test-checking'");
    await db.execute("INSERT INTO plaid_items (item_id, access_token, last_synced_at) VALUES ('item-1', 'x:y', 1)");
    const r = renderAccounts();
    await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
    r.stdin.write('\r');
    await waitFor(() => expect(flatFrame(r)).toContain('Edit: Test Checking'));
    expect(flatFrame(r)).not.toContain('Sheet link');
  });
});
