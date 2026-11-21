import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { parseCsvText } from './csv.js';
import { parseDate } from './csv-date.js';
import { parseCsvAmount } from './csv-amount.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { applyNameRulesWithRules, loadNameRules } from './rename.js';
import { applyTagRules } from './tag-rules.js';
import { recomputeAccountBalance } from './accounts.js';
import { cascadeDeleteTransactionsSql } from './imports.js';
import type { SyncItemResult } from './sync.js';

// An account whose transactions mirror a Google Sheet published as CSV (File →
// Share → Publish to web → CSV). The sheet is the source of truth: each sync
// adds rows with new IDs, updates rows whose values changed, and deletes rows
// whose ID is gone. For transactions no bank reports, like cash.
//
// Rows are ordinary transactions with source 'csv' and dedup_key 'sheet:<ID>',
// so rules, tags and edits treat them like any CSV row, and the unique index
// on (account_id, dedup_key) holds one row per sheet ID. Reusing 'csv' avoids
// rebuilding the transactions table to widen its source CHECK. CSV-vs-Plaid
// dedup only pairs rows within one account, and a sheet account has no Plaid
// rows, so it never touches these.
//
// The sheet's own ID column is what makes an edit an update rather than a
// delete plus an insert, which would drop the row's tags.

export type SheetSource = {
  accountId: string;
  url: string;
  /** Epoch ms of the last sync that applied the sheet; null until one has. */
  lastSyncedAt: number | null;
  /** Why the last sync failed, or which rows it skipped; null when it was clean. */
  lastError: string | null;
};

export type SheetRow = { line: number; id: string; date: string; name: string; amount: number; category: string | null };

export type SheetSkipReason = 'missing_id' | 'bad_date' | 'missing_description' | 'empty_amount' | 'bad_amount';

/** A row left out of a sync. One with an ID keeps its existing transaction as it is. */
export type SheetSkippedRow = { line: number; id: string | null; reason: SheetSkipReason };

export type ParsedSheet = { rows: SheetRow[]; skipped: SheetSkippedRow[] };

export type SheetSyncResult = { added: number; updated: number; removed: number; skipped: SheetSkippedRow[] };

/** Same wait between syncs as a Plaid item gets. */
export const SHEET_DEBOUNCE_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_SHEET_BYTES = 5 * 1024 * 1024;

const PUBLISH_HOWTO = 'In Google Sheets use File → Share → Publish to web, pick the tab and "Comma-separated values (.csv)", and copy that link';
const NOT_CSV = `The link returned a web page, not CSV. ${PUBLISH_HOWTO}.`;

const REQUIRED_HEADERS = ['id', 'date', 'description', 'amount'] as const;

const SKIP_LABEL: Record<SheetSkipReason, string> = {
  missing_id: 'no ID',
  bad_date: 'unreadable date',
  missing_description: 'no description',
  empty_amount: 'no amount',
  bad_amount: 'unreadable amount',
};

/** The transaction id for sheet row `sheetId` on `accountId`. */
export const sheetTxId = (accountId: string, sheetId: string) => `sheet-${accountId}-${sheetId}`;

const SHEET_KEY_PREFIX = 'sheet:';

/** Trims and checks a pasted link. Throws with what to do instead. */
export function checkSheetUrl(raw: string): string {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`That isn't a link. ${PUBLISH_HOWTO}.`);
  }
  if (parsed.protocol !== 'https:') throw new Error('The sheet link must start with https://');
  if (parsed.hostname === 'docs.google.com' && /\/edit\b/.test(parsed.pathname)) {
    throw new Error(`That's the sheet's edit link. ${PUBLISH_HOWTO}.`);
  }
  return url;
}

/**
 * Reads a sheet's CSV. Throws on a problem with the whole sheet (it isn't
 * CSV, a required header is missing, an ID appears twice), since applying
 * any of it then could delete the wrong rows. A bad row only lands in
 * `skipped`. Headers are matched ignoring case; extra columns are ignored.
 */
export function parseSheetCsv(text: string): ParsedSheet {
  if (/^\s*</.test(text)) throw new Error(NOT_CSV);
  const { headers, rows, lines } = parseCsvText(text);
  const names = headers.map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  const missing = REQUIRED_HEADERS.filter((h) => !names.includes(h));
  if (missing.length > 0) {
    const list = missing.map((h) => (h === 'id' ? 'ID' : h[0].toUpperCase() + h.slice(1))).join(', ');
    throw new Error(`The sheet's first row is missing ${list}. Add a header row with ID, Date, Description and Amount (Category is optional), then try again.`);
  }
  const idCol = names.indexOf('id');
  const dateCol = names.indexOf('date');
  const descCol = names.indexOf('description');
  const amountCol = names.indexOf('amount');
  const categoryCol = names.indexOf('category');

  const out: ParsedSheet = { rows: [], skipped: [] };
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const line = lines[i];
    // Sheets publishes trailing empty rows as `,,,`.
    if (row.every((f) => f === '')) return;
    const cell = (c: number) => (c === -1 ? '' : row[c] ?? '');
    const id = cell(idCol);
    if (!id) { out.skipped.push({ line, id: null, reason: 'missing_id' }); return; }
    const earlier = seen.get(id);
    if (earlier !== undefined) throw new Error(`ID ${id} is on both row ${earlier} and row ${line} of the sheet. Each row needs its own ID.`);
    seen.set(id, line);

    const skip = (reason: SheetSkipReason) => out.skipped.push({ line, id, reason });
    const date = parseDate(cell(dateCol));
    if (date === null) { skip('bad_date'); return; }
    const name = cell(descCol);
    if (!name) { skip('missing_description'); return; }
    if (!cell(amountCol)) { skip('empty_amount'); return; }
    const amount = parseCsvAmount(cell(amountCol));
    if (amount === null) { skip('bad_amount'); return; }
    out.rows.push({
      line, id, date, name,
      amount: Math.sign(amount) * Math.round(Math.abs(amount) * 100) / 100 + 0,
      category: cell(categoryCol) || null,
    });
  });
  return out;
}

/** "Skipped 2 rows: row 4 (unreadable date), row 9 (no ID)". */
export function describeSkipped(skipped: SheetSkippedRow[]): string {
  const shown = skipped.slice(0, 3).map((s) => `row ${s.line} (${SKIP_LABEL[s.reason]})`).join(', ');
  const more = skipped.length > 3 ? `, and ${skipped.length - 3} more` : '';
  return `Skipped ${skipped.length} row${skipped.length === 1 ? '' : 's'}: ${shown}${more}`;
}

async function fetchSheetText(url: string, fetchImpl: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(timedOut
      ? `The sheet didn't respond within ${FETCH_TIMEOUT_MS / 1000} seconds`
      : `Couldn't reach the sheet: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`The sheet link returned HTTP ${res.status}. Check that the sheet is still published to the web.`);
  if ((res.headers.get('content-type') ?? '').includes('text/html')) throw new Error(NOT_CSV);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_SHEET_BYTES) throw new Error('The sheet is larger than 5 MB');
  const text = await res.text();
  if (text.length > MAX_SHEET_BYTES) throw new Error('The sheet is larger than 5 MB');
  return text;
}

type SourceRow = { account_id: string; url: string; last_synced_at: number | null; last_error: string | null };

const toSource = (r: SourceRow): SheetSource => ({
  accountId: String(r.account_id),
  url: String(r.url),
  lastSyncedAt: r.last_synced_at === null ? null : Number(r.last_synced_at),
  lastError: r.last_error === null ? null : String(r.last_error),
});

export async function getSheetSources(): Promise<SheetSource[]> {
  const result = await db.execute('SELECT account_id, url, last_synced_at, last_error FROM sheet_sources ORDER BY account_id');
  return (result.rows as unknown as SourceRow[]).map(toSource);
}

export async function getSheetSource(accountId: string): Promise<SheetSource | null> {
  const result = await db.execute({
    sql: 'SELECT account_id, url, last_synced_at, last_error FROM sheet_sources WHERE account_id = ?',
    args: [accountId],
  });
  const row = result.rows[0] as unknown as SourceRow | undefined;
  return row ? toSource(row) : null;
}

/**
 * Fetches and reads a sheet without writing anything, so a link is checked
 * (reachable, CSV, the required headers, no repeated ID) before it's saved.
 * Throws with what to fix.
 */
export async function previewSheet(url: string, fetchImpl: typeof fetch = fetch): Promise<ParsedSheet> {
  return parseSheetCsv(await fetchSheetText(checkSheetUrl(url), fetchImpl));
}

/**
 * Links an account to a published sheet, or changes its link, after checking
 * the sheet with previewSheet. A new link syncs on the next sync whatever the
 * debounce; saving the same link again changes nothing. Bank-linked accounts
 * are refused, since Plaid already owns them, and so are manual assets, whose
 * value a sync would overwrite with a balance derived from rows.
 */
export async function setSheetLink(accountId: string, url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const clean = checkSheetUrl(url);
  const result = await db.execute({ sql: 'SELECT item_id FROM accounts WHERE id = ?', args: [accountId] });
  const row = result.rows[0] as unknown as { item_id: string | null } | undefined;
  if (!row) throw new Error(`No account with id ${accountId}`);
  if (row.item_id !== null) throw new Error("A bank-linked account syncs from Plaid and can't also sync from a sheet");
  if (accountId.startsWith('manual-')) throw new Error("A manual asset's value is entered by hand, so it can't sync from a sheet");
  if ((await getSheetSource(accountId))?.url === clean) return;
  await previewSheet(clean, fetchImpl);
  await db.execute({
    sql: `INSERT INTO sheet_sources (account_id, url, last_synced_at, last_error) VALUES (?, ?, NULL, NULL)
          ON CONFLICT(account_id) DO UPDATE SET url = excluded.url, last_synced_at = NULL, last_error = NULL
          WHERE sheet_sources.url <> excluded.url`,
    args: [accountId, clean],
  });
}

/** Unlinks the sheet. The account's transactions stay; nothing syncs them any more. */
export async function clearSheetLink(accountId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM sheet_sources WHERE account_id = ?', args: [accountId] });
}

/**
 * Creates an account backed by a sheet, once previewSheet has checked the
 * sheet; nothing is created when it fails. The account starts excluded from
 * net worth: a cash ledger has no real balance, and totaling its rows would
 * only drag net worth down month after month. Its transactions still count
 * as spending.
 */
export async function createSheetAccount(name: string, url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Account name is required');
  const clean = checkSheetUrl(url);
  await previewSheet(clean, fetchImpl);
  const id = `csv-acct-${randomUUID()}`;
  await db.batch([
    { sql: "INSERT INTO accounts (id, name, type, subtype, excluded) VALUES (?, ?, 'other', NULL, 1)", args: [id, trimmed] },
    { sql: 'INSERT INTO sheet_sources (account_id, url) VALUES (?, ?)', args: [id, clean] },
  ], 'write');
  return id;
}

type ExistingRow = {
  id: string; dedup_key: string; date: string; original_date: string | null;
  name: string; amount: number; category: string | null; manual_category: string | null;
};

const cents = (n: number) => Math.round(n * 100);

/** Mirrors a parsed sheet onto the account in one batch. */
async function applySheet(accountId: string, sheet: ParsedSheet): Promise<SheetSyncResult> {
  const existing = (await db.execute({
    sql: `SELECT id, dedup_key, date, original_date, name, amount, category, manual_category
          FROM transactions WHERE account_id = ? AND dedup_key LIKE 'sheet:%'`,
    args: [accountId],
  })).rows as unknown as ExistingRow[];
  const bySheetId = new Map(existing.map((r) => [String(r.dedup_key).slice(SHEET_KEY_PREFIX.length), r]));

  // A skipped row that still has its ID keeps its transaction: a typo in the
  // sheet shouldn't delete what was there.
  const keep = new Set([...sheet.rows.map((r) => r.id), ...sheet.skipped.flatMap((s) => (s.id === null ? [] : [s.id]))]);
  if (keep.size === 0 && existing.length > 0) {
    throw new Error(`The sheet has no rows, so syncing would delete all ${existing.length} of this account's transactions. Check that the link points at the right tab.`);
  }

  const [categoryRules, nameRules] = await Promise.all([loadCategoryRules(), loadNameRules()]);
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  const newIds: string[] = [];
  let updated = 0;

  for (const r of sheet.rows) {
    const display = applyNameRulesWithRules(nameRules, r.name, r.amount, accountId);
    const displayName = display !== r.name ? display : null;
    const old = bySheetId.get(r.id);
    if (!old) {
      const id = sheetTxId(accountId, r.id);
      const category = r.category ?? categorizeWithRules(categoryRules, r.name, null, null, r.amount, accountId);
      stmts.push({
        sql: `INSERT INTO transactions
                (id, account_id, date, name, amount, category, raw_category, pending, manual_category, display_name, source, import_id, dedup_key)
              VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 'csv', NULL, ?)`,
        args: [id, accountId, r.date, r.name, r.amount, category, r.category, displayName, SHEET_KEY_PREFIX + r.id],
      });
      newIds.push(id);
      continue;
    }

    // A transaction reattributed to another period keeps that date; the sheet
    // only moves the posting date behind it.
    const reattributed = old.original_date !== null;
    const changed = r.date !== (reattributed ? old.original_date : old.date)
      || r.name !== old.name
      || cents(r.amount) !== cents(Number(old.amount))
      || (r.category !== null && (r.category !== old.category || r.category !== old.manual_category));
    if (!changed) continue;
    updated++;
    // The sheet's category wins when it has one. Otherwise a category set by
    // hand in fungible stays, and rules re-run for the new description/amount.
    const manual = r.category ?? old.manual_category;
    const category = manual ?? categorizeWithRules(categoryRules, r.name, null, null, r.amount, accountId);
    stmts.push({
      sql: `UPDATE transactions SET date = ?, original_date = ?, name = ?, amount = ?, category = ?, manual_category = ?, display_name = ?
            WHERE id = ?`,
      args: [reattributed ? old.date : r.date, reattributed ? r.date : null, r.name, r.amount, category, manual, displayName, old.id],
    });
  }

  const gone = existing.filter((r) => !keep.has(String(r.dedup_key).slice(SHEET_KEY_PREFIX.length))).map((r) => String(r.id));
  if (gone.length > 0) stmts.push(...cascadeDeleteTransactionsSql(gone));

  if (stmts.length > 0) await db.batch(stmts, 'write');
  // Tag only genuinely new rows so a tag a user removed never returns.
  await applyTagRules({ txIds: newIds });
  // Also keeps the balance date fresh, so the account doesn't read as stale.
  await recomputeAccountBalance(accountId);
  return { added: newIds.length, updated, removed: gone.length, skipped: sheet.skipped };
}

/**
 * Fetches the account's sheet and mirrors it. On any problem with the whole
 * sheet nothing changes, the reason is saved as lastError, and it throws.
 * Skipped rows don't fail the sync but are saved as lastError too, since a
 * row silently missing from a cash ledger is easy to never notice.
 */
export async function syncSheet(accountId: string, fetchImpl: typeof fetch = fetch): Promise<SheetSyncResult> {
  const source = await getSheetSource(accountId);
  if (!source) throw new Error('This account has no sheet link');
  let result: SheetSyncResult;
  try {
    result = await applySheet(accountId, parseSheetCsv(await fetchSheetText(source.url, fetchImpl)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute({ sql: 'UPDATE sheet_sources SET last_error = ? WHERE account_id = ?', args: [message, accountId] });
    throw err;
  }
  await db.execute({
    sql: 'UPDATE sheet_sources SET last_synced_at = ?, last_error = ? WHERE account_id = ?',
    args: [Date.now(), result.skipped.length > 0 ? describeSkipped(result.skipped) : null, accountId],
  });
  return result;
}

/**
 * Syncs every linked sheet (for syncAll), or just those of `accountIds`.
 * Results are keyed by account id, so a failure shows on that account's row
 * and in the sync banner. Skipped rows come back as an error too: the sync
 * applied, but the sheet needs fixing.
 */
export async function syncSheets(force = false, accountIds?: string[], fetchImpl: typeof fetch = fetch): Promise<SyncItemResult[]> {
  const results: SyncItemResult[] = [];
  const sources = await getSheetSources();
  for (const source of accountIds ? sources.filter((s) => accountIds.includes(s.accountId)) : sources) {
    const base = { itemId: source.accountId, added: 0, modified: 0, removed: 0, dupes: 0 };
    if (!force && source.lastSyncedAt !== null && Date.now() - source.lastSyncedAt < SHEET_DEBOUNCE_MS) {
      results.push({ ...base, skipped: true });
      continue;
    }
    try {
      const r = await syncSheet(source.accountId, fetchImpl);
      results.push({
        ...base, added: r.added, modified: r.updated, removed: r.removed, skipped: false,
        ...(r.skipped.length > 0 ? { error: describeSkipped(r.skipped) } : {}),
      });
    } catch (err) {
      results.push({ ...base, skipped: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
