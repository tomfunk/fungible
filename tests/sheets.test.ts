import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  parseSheetCsv, checkSheetUrl, describeSkipped, setSheetLink, clearSheetLink, getSheetSource,
  createSheetAccount, syncSheet, syncSheets, sheetTxId, SHEET_DEBOUNCE_MS,
} from '../core/sheets.js';
import { deleteAccount } from '../core/accounts.js';
import { syncAll } from '../core/sync.js';
import { getOrCreateTag, addTagToTransactions } from '../core/tags.js';
import { setTransactionDate } from '../core/transactions.js';

const URL_A = 'https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true&output=csv';
const URL_B = 'https://docs.google.com/spreadsheets/d/e/2PACX-def/pub?gid=0&single=true&output=csv';
const ACCT = 'csv-acct-cash';

const HEADER = 'ID,Date,Description,Amount';

/** A fetch that serves `body` as CSV, or whatever `init` says. */
function serve(body: string, init: ResponseInit = { headers: { 'content-type': 'text/csv' } }) {
  return vi.fn(async () => new Response(body, init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** An empty but well-formed sheet, which is all linking needs. */
const blankSheet = () => serve(`${HEADER}\n`);

const link = (accountId: string, url: string) => setSheetLink(accountId, url, blankSheet());

async function sheetRows() {
  const r = await db.execute({
    sql: `SELECT id, date, original_date, name, amount, category, manual_category, display_name, source, dedup_key
          FROM transactions WHERE account_id = ? ORDER BY dedup_key`,
    args: [ACCT],
  });
  return r.rows as unknown as {
    id: string; date: string; original_date: string | null; name: string; amount: number; category: string | null;
    manual_category: string | null; display_name: string | null; source: string; dedup_key: string;
  }[];
}

async function tagNamesOf(txId: string): Promise<string[]> {
  const r = await db.execute({
    sql: 'SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY tg.name',
    args: [txId],
  });
  return r.rows.map((x) => String(x.name));
}

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions', 'accounts', 'balance_history',
    'category_rules', 'name_rules', 'sheet_sources', 'plaid_items', 'imports']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch([
    { sql: "INSERT INTO accounts (id, name, type) VALUES (?, 'Cash', 'other')", args: [ACCT] },
    "INSERT INTO accounts (id, name, type, item_id) VALUES ('plaid-acct', 'Checking', 'depository', 'item-1')",
  ], 'write');
  // Every fetch a test means to make is passed in; anything else is a bug.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call'); }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('parseSheetCsv', () => {
  it('reads rows, matching headers ignoring case and order, ignoring extra columns', () => {
    const parsed = parseSheetCsv('Notes,amount,DATE,description,id,Category\nhi,40.00,10/05/2026,Babysitter,1,Childcare\n,"$1,250.5",2026-10-06,Rent,2,\n');
    expect(parsed.skipped).toEqual([]);
    expect(parsed.rows).toEqual([
      { line: 2, id: '1', date: '2026-10-05', name: 'Babysitter', amount: 40, category: 'Childcare' },
      { line: 3, id: '2', date: '2026-10-06', name: 'Rent', amount: 1250.5, category: null },
    ]);
  });

  it('drops the blank rows Sheets publishes at the end', () => {
    expect(parseSheetCsv(`${HEADER}\n1,2026-10-05,Sitter,40\n,,,\n,,,\n`).rows).toHaveLength(1);
  });

  it('skips bad rows with a reason, keeping their IDs', () => {
    const parsed = parseSheetCsv([
      HEADER,
      ',2026-10-05,No id,10',
      '2,13/45/2026,Bad date,10',
      '3,2026-10-05,,10',
      '4,2026-10-05,No amount,',
      '5,2026-10-05,Bad amount,ten',
      '6,2026-10-05,Good,10',
    ].join('\n'));
    expect(parsed.rows.map((r) => r.id)).toEqual(['6']);
    expect(parsed.skipped).toEqual([
      { line: 2, id: null, reason: 'missing_id' },
      { line: 3, id: '2', reason: 'bad_date' },
      { line: 4, id: '3', reason: 'missing_description' },
      { line: 5, id: '4', reason: 'empty_amount' },
      { line: 6, id: '5', reason: 'bad_amount' },
    ]);
  });

  it('refuses a sheet missing a required header', () => {
    expect(() => parseSheetCsv('ID,Date,Amount\n1,2026-10-05,40')).toThrow(/missing Description/);
  });

  it('refuses a sheet with a repeated ID', () => {
    expect(() => parseSheetCsv(`${HEADER}\n7,2026-10-05,A,1\n7,2026-10-06,B,2`)).toThrow(/ID 7 is on both row 2 and row 3/);
  });

  it('refuses HTML', () => {
    expect(() => parseSheetCsv('<!DOCTYPE html><html>sign in</html>')).toThrow(/web page, not CSV/);
  });
});

describe('describeSkipped', () => {
  it('names the first three rows and counts the rest', () => {
    const s = [2, 3, 4, 5, 6].map((line) => ({ line, id: String(line), reason: 'bad_date' as const }));
    expect(describeSkipped(s.slice(0, 1))).toBe('Skipped 1 row: row 2 (unreadable date)');
    expect(describeSkipped(s)).toBe('Skipped 5 rows: row 2 (unreadable date), row 3 (unreadable date), row 4 (unreadable date), and 2 more');
  });
});

describe('checkSheetUrl', () => {
  it('trims a published link', () => {
    expect(checkSheetUrl(`  ${URL_A} `)).toBe(URL_A);
  });

  it('rejects non-links, http, and the edit link', () => {
    expect(() => checkSheetUrl('not a link')).toThrow(/isn't a link/);
    expect(() => checkSheetUrl('http://example.com/x.csv')).toThrow(/https/);
    expect(() => checkSheetUrl('https://docs.google.com/spreadsheets/d/abc/edit#gid=0')).toThrow(/edit link/);
  });
});

describe('linking', () => {
  it('links, relinks to a new URL (resetting sync state), and unlinks', async () => {
    const fetchA = blankSheet();
    await setSheetLink(ACCT, URL_A, fetchA);
    expect(fetchA).toHaveBeenCalledWith(URL_A, expect.anything());
    expect(await getSheetSource(ACCT)).toEqual({ accountId: ACCT, url: URL_A, lastSyncedAt: null, lastError: null });
    await db.execute({ sql: "UPDATE sheet_sources SET last_synced_at = 5, last_error = 'x'", args: [] });

    const again = blankSheet();
    await setSheetLink(ACCT, ` ${URL_A} `, again); // same link: nothing changes, nothing fetched
    expect(again).not.toHaveBeenCalled();
    expect((await getSheetSource(ACCT))?.lastSyncedAt).toBe(5);

    await link(ACCT, URL_B);
    expect(await getSheetSource(ACCT)).toEqual({ accountId: ACCT, url: URL_B, lastSyncedAt: null, lastError: null });

    await clearSheetLink(ACCT);
    expect(await getSheetSource(ACCT)).toBeNull();
  });

  it('refuses bank-linked accounts, manual assets and unknown accounts', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, subtype) VALUES ('manual-house', 'House', 'other', 'manual')");
    await expect(link('plaid-acct', URL_A)).rejects.toThrow(/Plaid/);
    await expect(link('manual-house', URL_A)).rejects.toThrow(/manual asset/);
    await expect(link('nope', URL_A)).rejects.toThrow(/No account/);
    expect(await getSheetSource('plaid-acct')).toBeNull();
  });

  it('checks the sheet before linking, and keeps the old link when it fails', async () => {
    await link(ACCT, URL_A);
    await expect(setSheetLink(ACCT, URL_B, serve('ID,Date,Amount\n'))).rejects.toThrow(
      "The sheet's first row is missing Description. Add a header row with ID, Date, Description and Amount (Category is optional), then try again.",
    );
    await expect(setSheetLink(ACCT, URL_B, serve('', { status: 404 }))).rejects.toThrow(/HTTP 404/);
    expect((await getSheetSource(ACCT))?.url).toBe(URL_A);
  });

  it('creates an account excluded from net worth, linked to the sheet', async () => {
    const id = await createSheetAccount('  Cash (Pat) ', URL_A, blankSheet());
    const acct = (await db.execute({ sql: 'SELECT name, type, excluded, item_id FROM accounts WHERE id = ?', args: [id] })).rows[0];
    expect(acct).toMatchObject({ name: 'Cash (Pat)', type: 'other', excluded: 1, item_id: null });
    expect((await getSheetSource(id))?.url).toBe(URL_A);
  });

  it('creates nothing when the name, link or sheet is bad', async () => {
    await expect(createSheetAccount('Cash', 'http://x', blankSheet())).rejects.toThrow();
    await expect(createSheetAccount(' ', URL_A, blankSheet())).rejects.toThrow(/name/);
    await expect(createSheetAccount('Cash', URL_A, serve('Date,Description,Amount\n'))).rejects.toThrow(/missing ID\. Add a header row/);
    await expect(createSheetAccount('Cash', URL_A, serve('<html>', { headers: { 'content-type': 'text/html' } }))).rejects.toThrow(/web page/);
    expect((await db.execute('SELECT COUNT(*) AS n FROM accounts')).rows[0].n).toBe(2);
    expect((await db.execute('SELECT COUNT(*) AS n FROM sheet_sources')).rows[0].n).toBe(0);
  });

  it('deleting the account removes its link', async () => {
    await link(ACCT, URL_A);
    await deleteAccount(ACCT);
    expect(await getSheetSource(ACCT)).toBeNull();
  });
});

describe('syncSheet', () => {
  beforeEach(async () => { await link(ACCT, URL_A); });

  it('inserts new rows as CSV transactions keyed by sheet ID, and records the sync', async () => {
    const fetchImpl = serve(`${HEADER},Category\n1,2026-10-05,Babysitter,40,Childcare\n2,2026-10-06,Snacks,-5,\n`);
    const result = await syncSheet(ACCT, fetchImpl);
    expect(result).toEqual({ added: 2, updated: 0, removed: 0, skipped: [] });
    expect(fetchImpl).toHaveBeenCalledWith(URL_A, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const rows = await sheetRows();
    expect(rows).toMatchObject([
      { id: sheetTxId(ACCT, '1'), date: '2026-10-05', name: 'Babysitter', amount: 40, category: 'Childcare', manual_category: 'Childcare', source: 'csv', dedup_key: 'sheet:1' },
      { id: sheetTxId(ACCT, '2'), amount: -5, manual_category: null, dedup_key: 'sheet:2' },
    ]);
    const source = await getSheetSource(ACCT);
    expect(source?.lastSyncedAt).toEqual(expect.any(Number));
    expect(source?.lastError).toBeNull();
    // The balance is derived from the rows, as for a CSV account.
    const bal = (await db.execute({ sql: 'SELECT balance FROM balance_history WHERE account_id = ?', args: [ACCT] })).rows[0];
    expect(Number(bal.balance)).toBe(-35);
  });

  it('runs category, name and tag rules on new rows', async () => {
    const joint = await getOrCreateTag('joint');
    await db.batch([
      "INSERT INTO category_rules (match_type, pattern, category) VALUES ('name', 'sitter', 'Childcare')",
      "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'sitter', 'Babysitting')",
      { sql: "INSERT INTO tag_rules (match_type, pattern, tag_id, account_id) VALUES ('all', '', ?, ?)", args: [joint, ACCT] },
    ], 'write');
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,babysitter,40\n`));
    const [row] = await sheetRows();
    expect(row).toMatchObject({ category: 'Childcare', manual_category: null, display_name: 'Babysitting' });
    expect(await tagNamesOf(row.id)).toEqual(['joint']);
  });

  it('updates an edited row in place, keeping its tags, and leaves unchanged rows alone', async () => {
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n2,2026-10-06,Snacks,5\n`));
    await addTagToTransactions([sheetTxId(ACCT, '1')], await getOrCreateTag('settled'));

    const result = await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-07,Sitter (late),45.5\n2,2026-10-06,Snacks,5\n`));
    expect(result).toEqual({ added: 0, updated: 1, removed: 0, skipped: [] });
    expect((await sheetRows())[0]).toMatchObject({ id: sheetTxId(ACCT, '1'), date: '2026-10-07', name: 'Sitter (late)', amount: 45.5 });
    expect(await tagNamesOf(sheetTxId(ACCT, '1'))).toEqual(['settled']);
  });

  it("keeps a category set by hand when the sheet has none, and lets the sheet's own category win", async () => {
    await syncSheet(ACCT, serve(`${HEADER},Category\n1,2026-10-05,Sitter,40,\n2,2026-10-05,Snacks,5,\n`));
    await db.execute({ sql: "UPDATE transactions SET category = 'Childcare', manual_category = 'Childcare'", args: [] });
    await syncSheet(ACCT, serve(`${HEADER},Category\n1,2026-10-05,Sitter,41,\n2,2026-10-05,Snacks,5,Grocery\n`));
    const [one, two] = await sheetRows();
    expect(one).toMatchObject({ amount: 41, category: 'Childcare', manual_category: 'Childcare' });
    expect(two).toMatchObject({ category: 'Grocery', manual_category: 'Grocery' });
  });

  it('keeps a reattributed date, moving only the posting date behind it', async () => {
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-31,Sitter,40\n`));
    await setTransactionDate(sheetTxId(ACCT, '1'), '2026-11-01');
    expect((await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-31,Sitter,40\n`))).updated).toBe(0);
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-30,Sitter,40\n`));
    expect((await sheetRows())[0]).toMatchObject({ date: '2026-11-01', original_date: '2026-10-30' });
  });

  it('deletes rows whose ID left the sheet, with their tags', async () => {
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n2,2026-10-06,Snacks,5\n`));
    await addTagToTransactions([sheetTxId(ACCT, '2')], await getOrCreateTag('joint'));
    const result = await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`));
    expect(result.removed).toBe(1);
    expect((await sheetRows()).map((r) => r.dedup_key)).toEqual(['sheet:1']);
    expect(await tagNamesOf(sheetTxId(ACCT, '2'))).toEqual([]);
  });

  it("never touches the account's other transactions", async () => {
    await db.execute({
      sql: "INSERT INTO transactions (id, account_id, date, name, amount, pending, source, dedup_key) VALUES ('csv-1-0', ?, '2026-10-01', 'Old import', 9, 0, 'csv', '2026-10-01|old import|900|0')",
      args: [ACCT],
    });
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`));
    expect((await sheetRows()).map((r) => r.id)).toContain('csv-1-0');
  });

  it("applies good rows, keeps a bad row's existing transaction, and reports it", async () => {
    await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`));
    const result = await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,forty\n2,2026-10-06,Snacks,5\n`));
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, skipped: [{ line: 2, id: '1', reason: 'bad_amount' }] });
    expect((await sheetRows()).map((r) => [r.dedup_key, r.amount])).toEqual([['sheet:1', 40], ['sheet:2', 5]]);
    const source = await getSheetSource(ACCT);
    expect(source?.lastError).toBe('Skipped 1 row: row 2 (unreadable amount)');
    expect(source?.lastSyncedAt).toEqual(expect.any(Number));
  });

  describe('changes nothing and records why when the whole sheet is bad', () => {
    const cases: [string, ReturnType<typeof serve>, RegExp][] = [
      ['an HTML page', serve('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), /web page/],
      ['an HTTP error', serve('', { status: 404 }), /HTTP 404/],
      ['a missing header', serve('ID,Date,Amount\n1,2026-10-05,40\n'), /missing Description/],
      ['a repeated ID', serve(`${HEADER}\n1,2026-10-05,A,1\n1,2026-10-05,B,2\n`), /ID 1 is on both/],
      ['an empty sheet', serve(`${HEADER}\n`), /no rows/],
    ];
    it.each(cases)('%s', async (_label, fetchImpl, message) => {
      await syncSheet(ACCT, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`));
      const before = await sheetRows();
      const syncedAt = (await getSheetSource(ACCT))?.lastSyncedAt;
      await expect(syncSheet(ACCT, fetchImpl)).rejects.toThrow(message);
      expect(await sheetRows()).toEqual(before);
      const source = await getSheetSource(ACCT);
      expect(source?.lastError).toMatch(message);
      expect(source?.lastSyncedAt).toBe(syncedAt);
    });

    it('a network failure', async () => {
      const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
      await expect(syncSheet(ACCT, fetchImpl)).rejects.toThrow(/Couldn't reach the sheet: fetch failed/);
      expect((await getSheetSource(ACCT))?.lastError).toMatch(/fetch failed/);
    });
  });

  it('an empty sheet is fine while the account has no sheet rows', async () => {
    expect(await syncSheet(ACCT, serve(`${HEADER}\n`))).toEqual({ added: 0, updated: 0, removed: 0, skipped: [] });
  });
});

describe('syncSheets', () => {
  beforeEach(async () => { await link(ACCT, URL_A); });

  it('reports each sheet keyed by account id', async () => {
    const results = await syncSheets(false, undefined, serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`));
    expect(results).toEqual([{ itemId: ACCT, added: 1, modified: 0, removed: 0, dupes: 0, skipped: false }]);
  });

  it('syncs only the accounts asked for', async () => {
    const other = 'csv-acct-other';
    await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES (?, 'Cash 2', 'other')", args: [other] });
    await link(other, URL_B);
    const fetchImpl = serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`);
    expect((await syncSheets(true, [other], fetchImpl)).map((r) => r.itemId)).toEqual([other]);
    expect(fetchImpl).toHaveBeenCalledWith(URL_B, expect.anything());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits 15 minutes between syncs unless forced', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
    const fetchImpl = serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`);
    await syncSheets(false, undefined, fetchImpl);
    vi.setSystemTime(Date.now() + SHEET_DEBOUNCE_MS - 1000);
    expect((await syncSheets(false, undefined, fetchImpl))[0].skipped).toBe(true);
    expect((await syncSheets(true, undefined, fetchImpl))[0].skipped).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a failed sheet and skipped rows as errors without stopping the others', async () => {
    const other = 'csv-acct-other';
    await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES (?, 'Cash 2', 'other')", args: [other] });
    await link(other, URL_B);
    const fetchImpl = vi.fn(async (url: string) => (url === URL_A
      ? new Response('<html>', { headers: { 'content-type': 'text/html' } })
      : new Response(`${HEADER}\n1,2026-10-05,Sitter,40\n2,bad,Snacks,5\n`))) as unknown as typeof fetch;
    const results = await syncSheets(true, undefined, fetchImpl);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: ACCT, error: expect.stringMatching(/web page/) }),
      expect.objectContaining({ itemId: other, added: 1, error: 'Skipped 1 row: row 3 (unreadable date)' }),
    ]));
  });
});

describe('syncAll', () => {
  beforeEach(async () => { await link(ACCT, URL_A); });

  it('syncs sheets on a full sync but not a scoped one', async () => {
    const fetchImpl = serve(`${HEADER}\n1,2026-10-05,Sitter,40\n`);
    vi.stubGlobal('fetch', fetchImpl);
    expect(await syncAll(true, ['item-none'])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await syncAll(true)).toEqual([{ itemId: ACCT, added: 1, modified: 0, removed: 0, dupes: 0, skipped: false }]);
  });
});
