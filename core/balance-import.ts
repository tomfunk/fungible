// Balance-history CSV import (Issue #58). Takes CSV *text* (no fs) with a
// required header row `date,account,balance`, and writes balance_history rows
// for accounts that already exist. It never creates accounts.
//
// Preview and commit share ONE resolver (resolveBalanceImport), so the numbers
// shown to the user are exactly the numbers written.
//
// Only rows strictly OLDER than an account's current latest snapshot are
// importable: the latest balance_history row drives net worth and health, so
// an import must backfill history, never replace the current balance.
//
// Sign convention: credit/loan balances are the amount owed, stored positive
// and never flipped (same as synced data).

import { db } from './db.js';
import { notifyChange } from './refresh.js';

export const BALANCE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const BALANCE_IMPORT_MAX_ROWS = 50_000;

import {
  BALANCE_IMPORT_SKIP_REASONS,
  BALANCE_IMPORT_SKIP_COPY,
  summarizeSkips,
  type BalanceImportSkipReason,
} from './balance-import-copy.js';

export { BALANCE_IMPORT_SKIP_REASONS, BALANCE_IMPORT_SKIP_COPY, summarizeSkips };
export type { BalanceImportSkipReason };


export type BalanceImportSkip = {
  line: number;
  raw: string;
  reason: BalanceImportSkipReason;
  message: string;
};

export type BalanceImportOptions = {
  /** CSV account name (trimmed, case-insensitive) -> account id, or null to skip those rows. */
  accountMap?: Record<string, string | null>;
  /** YYYY-MM-DD; rows after this date are skipped as future_date. Defaults to the local date. */
  today?: string;
};

export type BalanceImportPreview = {
  totalRows: number;
  valid: number;
  willInsert: number;
  willOverwrite: { count: number; changed: number };
  duplicatesInFile: number;
  skipped: BalanceImportSkip[];
  unmatched: { name: string; rows: number; suggestions: { id: string; name: string }[] }[];
  ambiguous: { name: string; candidates: { id: string; name: string }[] }[];
  resolved: { csvName: string; accountId: string; accountName: string; rows: number; minDate: string; maxDate: string }[];
  overwriteSample: { accountName: string; date: string; oldBalance: number; newBalance: number }[];
  /** Every matchable account, for mapping pickers. */
  accounts: { id: string; name: string }[];
  warnings: string[];
};

export type BalanceImportResult = {
  inserted: number;
  overwritten: number;
  skipped: number;
  accountsTouched: number;
};

// ─── CSV parsing ──────────────────────────────────────────────────────────────

export type BalanceCsvRecord = { line: number; raw: string; fields: string[] };

/**
 * Quote-aware CSV tokenizer (RFC 4180-ish). Tolerates a BOM, CRLF, lone CR,
 * blank lines and a missing trailing newline. `line` is the 1-based physical
 * line the record starts on; blank lines are dropped but still counted.
 */
export function tokenizeCsv(text: string): BalanceCsvRecord[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: BalanceCsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let startIdx = 0;
  let touched = false; // any non-newline content seen in the current record

  const endRecord = (endIdx: number) => {
    fields.push(field);
    const isBlank = fields.length === 1 && fields[0].trim() === '' && !touched;
    if (!isBlank) records.push({ line: startLine, raw: text.slice(startIdx, endIdx), fields });
    fields = [];
    field = '';
    touched = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; touched = true; }
    else if (c === ',') { fields.push(field); field = ''; touched = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord(i);
      line++;
      startLine = line;
      startIdx = i + 1;
    } else { field += c; touched = true; }
  }
  if (touched || field !== '' || fields.length > 0) endRecord(text.length);
  return records;
}

export type ParsedBalanceCsv = {
  rows: { line: number; raw: string; date: string; account: string; balance: string; fieldCount: number; cells: string[] }[];
  /** Column indexes of the required header names. */
  columns: { date: number; account: number; balance: number };
};

/** Parses text into rows keyed off the required `date,account,balance` header. Throws on a bad header or size cap breach. */
export function parseBalanceCsv(text: string): ParsedBalanceCsv {
  if (typeof text !== 'string') throw new Error('CSV text is required.');
  if (Buffer.byteLength(text, 'utf8') > BALANCE_IMPORT_MAX_BYTES) {
    throw new Error(`CSV is too large (limit ${BALANCE_IMPORT_MAX_BYTES / 1024 / 1024} MB).`);
  }
  const records = tokenizeCsv(text);
  if (records.length === 0) throw new Error('CSV is empty: expected a header row with date, account, balance.');
  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  const columns = { date: col('date'), account: col('account'), balance: col('balance') };
  const missing = (Object.keys(columns) as (keyof typeof columns)[]).filter((k) => columns[k] < 0);
  if (missing.length) {
    throw new Error(`CSV header must include date, account, balance (missing: ${missing.join(', ')}).`);
  }
  const data = records.slice(1);
  if (data.length > BALANCE_IMPORT_MAX_ROWS) {
    throw new Error(`CSV has too many rows (${data.length}; limit ${BALANCE_IMPORT_MAX_ROWS}).`);
  }
  return {
    columns,
    rows: data.map((r) => ({
      line: r.line,
      raw: r.raw,
      cells: r.fields,
      fieldCount: r.fields.length,
      date: (r.fields[columns.date] ?? '').trim(),
      account: (r.fields[columns.account] ?? '').trim(),
      balance: (r.fields[columns.balance] ?? '').trim(),
    })),
  };
}

/** Real calendar ISO date check (rejects 2025-02-30). */
export function isRealIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Parses a balance cell. Accepts a leading '-', parentheses for negatives,
 * and strips '$', commas and spaces. Returns null for anything else.
 */
export function parseBalanceAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1).trim(); }
  s = s.replace(/[\s,]/g, '');
  const m = /^([+-])?\$?([+-])?(\d+(?:\.\d*)?|\.\d+)$/.exec(s);
  if (!m) return null;
  if (m[1] && m[2]) return null; // sign on both sides of '$'
  if (m[1] === '-' || m[2] === '-') {
    if (negative) return null; // "(-5)" is ambiguous
    negative = true;
  }
  const n = Number(m[3]);
  if (!Number.isFinite(n)) return null;
  return negative && n !== 0 ? -n : n;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

type AccountRow = { id: string; name: string; nickname: string | null; type: string; excluded: number };

type Plan = {
  preview: BalanceImportPreview;
  writes: { accountId: string; date: string; balance: number }[];
  overwritten: number;
};

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

async function resolveBalanceImport(csvText: string, opts: BalanceImportOptions = {}): Promise<Plan> {
  const today = opts.today ?? localToday();
  const parsed = parseBalanceCsv(csvText);

  const accountRows = (await db.execute('SELECT id, name, nickname, type, excluded FROM accounts ORDER BY name, id')).rows as unknown as AccountRow[];
  const byId = new Map(accountRows.map((a) => [a.id, a]));
  const byName = new Map<string, Set<string>>();
  const addName = (n: string | null, id: string) => {
    const k = (n ?? '').trim().toLowerCase();
    if (!k) return;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k)!.add(id);
  };
  for (const a of accountRows) { addName(a.name, a.id); addName(a.nickname, a.id); }

  const accountMap = new Map<string, string | null>();
  for (const [k, v] of Object.entries(opts.accountMap ?? {})) accountMap.set(k.trim().toLowerCase(), v);

  const displayName = (a: AccountRow) => (a.nickname?.trim() ? a.nickname.trim() : a.name);
  const warnings: string[] = [];
  const skipped: BalanceImportSkip[] = [];
  const skip = (r: { line: number; raw: string }, reason: BalanceImportSkipReason, message: string) =>
    skipped.push({ line: r.line, raw: r.raw, reason, message });

  // Pass 1: field validation + account resolution.
  type Row = { line: number; raw: string; csvName: string; accountId: string; date: string; balance: number };
  const pass1: Row[] = [];
  const unmatched = new Map<string, { name: string; rows: number }>();
  const ambiguous = new Map<string, { name: string; candidates: string[] }>();

  for (const r of parsed.rows) {
    if (!r.date || !r.account || !r.balance) {
      const which = [!r.date && 'date', !r.account && 'account', !r.balance && 'balance'].filter(Boolean).join(', ');
      skip(r, 'missing_field', `Line ${r.line}: missing ${which}.`);
      continue;
    }
    if (!isRealIsoDate(r.date)) {
      skip(r, 'invalid_date', `Line ${r.line}: "${r.date}" is not a valid YYYY-MM-DD date.`);
      continue;
    }
    const balance = parseBalanceAmount(r.balance);
    if (balance === null) {
      skip(r, 'invalid_amount', `Line ${r.line}: "${r.balance}" is not a valid balance.`);
      continue;
    }
    const key = r.account.toLowerCase();
    let accountId: string | null | undefined;
    if (accountMap.has(key)) {
      const mapped = accountMap.get(key);
      if (mapped === null) {
        skip(r, 'user_skipped', `Line ${r.line}: "${r.account}" was skipped by you.`);
        continue;
      }
      if (mapped && byId.has(mapped)) accountId = mapped;
      else {
        skip(r, 'no_matching_account', `Line ${r.line}: mapped account id "${mapped}" for "${r.account}" does not exist.`);
        continue;
      }
    } else {
      const ids = byName.get(key);
      if (!ids || ids.size === 0) {
        const u = unmatched.get(key) ?? { name: r.account, rows: 0 };
        u.rows++;
        unmatched.set(key, u);
        skip(r, 'no_matching_account', `Line ${r.line}: no account named "${r.account}".`);
        continue;
      }
      if (ids.size > 1) {
        if (!ambiguous.has(key)) ambiguous.set(key, { name: r.account, candidates: [...ids] });
        skip(r, 'ambiguous_account', `Line ${r.line}: "${r.account}" matches more than one account; map it to one.`);
        continue;
      }
      accountId = [...ids][0];
    }
    pass1.push({ line: r.line, raw: r.raw, csvName: r.account, accountId: accountId!, date: r.date, balance });
  }

  // Pass 2: last row wins for duplicate (account, date).
  const lastByKey = new Map<string, Row>();
  let duplicatesInFile = 0;
  for (const r of pass1) {
    const k = `${r.accountId}\u0000${r.date}`;
    if (lastByKey.has(k)) duplicatesInFile++;
    lastByKey.set(k, r);
  }
  if (duplicatesInFile) {
    warnings.push(`${duplicatesInFile} duplicate account/date row${duplicatesInFile === 1 ? '' : 's'} in the file; the last one for each was used.`);
  }
  const deduped = [...lastByKey.values()].sort((a, b) => a.line - b.line);

  // Pass 3: future-date and latest-snapshot guards.
  const latestRows = (await db.execute('SELECT account_id, MAX(date) AS d FROM balance_history GROUP BY account_id')).rows as unknown as { account_id: string; d: string }[];
  const latest = new Map(latestRows.map((r) => [r.account_id, r.d]));
  const pass3: Row[] = [];
  for (const r of deduped) {
    if (r.date > today) {
      skip(r, 'future_date', `Line ${r.line}: ${r.date} is in the future.`);
      continue;
    }
    const l = latest.get(r.accountId);
    if (l !== undefined && r.date >= l) {
      skip(r, 'newer_than_current', `Line ${r.line}: ${r.date} is not older than the current balance snapshot (${l}); only earlier history can be imported.`);
      continue;
    }
    pass3.push(r);
  }

  // Pass 4: insert vs overwrite.
  const touchedIds = [...new Set(pass3.map((r) => r.accountId))];
  const existing = new Map<string, number>();
  if (touchedIds.length) {
    const ph = touchedIds.map(() => '?').join(',');
    const ex = (await db.execute({ sql: `SELECT account_id, date, balance FROM balance_history WHERE account_id IN (${ph})`, args: touchedIds })).rows as unknown as { account_id: string; date: string; balance: number }[];
    for (const e of ex) existing.set(`${e.account_id}\u0000${e.date}`, Number(e.balance));
  }
  let willInsert = 0;
  let overwriteCount = 0;
  let changed = 0;
  let negativeLiability = 0;
  const overwriteSample: BalanceImportPreview['overwriteSample'] = [];
  const resolvedMap = new Map<string, BalanceImportPreview['resolved'][number]>();
  for (const r of pass3) {
    const acct = byId.get(r.accountId)!;
    const old = existing.get(`${r.accountId}\u0000${r.date}`);
    if (old === undefined) willInsert++;
    else {
      overwriteCount++;
      if (Math.abs(old - r.balance) >= 0.005) {
        changed++;
        if (overwriteSample.length < 10) {
          overwriteSample.push({ accountName: displayName(acct), date: r.date, oldBalance: old, newBalance: r.balance });
        }
      }
    }
    if ((acct.type === 'credit' || acct.type === 'loan') && r.balance < 0) negativeLiability++;
    const rk = `${r.csvName.toLowerCase()}\u0000${r.accountId}`;
    const cur = resolvedMap.get(rk);
    if (cur) {
      cur.rows++;
      if (r.date < cur.minDate) cur.minDate = r.date;
      if (r.date > cur.maxDate) cur.maxDate = r.date;
    } else {
      resolvedMap.set(rk, { csvName: r.csvName, accountId: r.accountId, accountName: displayName(acct), rows: 1, minDate: r.date, maxDate: r.date });
    }
  }
  if (negativeLiability) {
    warnings.push(`${negativeLiability} credit/loan balance${negativeLiability === 1 ? ' is' : 's are'} negative. Credit and loan balances are the amount owed and should be positive; they were imported as written.`);
  }
  const excludedUsed = touchedIds.filter((id) => byId.get(id)!.excluded);
  if (excludedUsed.length) {
    warnings.push(`Includes excluded account${excludedUsed.length === 1 ? '' : 's'} (not counted in net worth): ${excludedUsed.map((id) => displayName(byId.get(id)!)).join(', ')}.`);
  }

  skipped.sort((a, b) => a.line - b.line);

  const suggest = (name: string) => {
    const nt = new Set(tokens(name));
    const lower = name.toLowerCase();
    return accountRows
      .map((a) => {
        const hay = `${a.name} ${a.nickname ?? ''}`.toLowerCase();
        let score = 0;
        for (const t of tokens(hay)) if (nt.has(t)) score++;
        if (hay.includes(lower) || (lower.length > 2 && lower.includes(a.name.toLowerCase()))) score += 2;
        return { a, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map((x) => ({ id: x.a.id, name: displayName(x.a) }));
  };

  const preview: BalanceImportPreview = {
    totalRows: parsed.rows.length,
    valid: pass3.length,
    willInsert,
    willOverwrite: { count: overwriteCount, changed },
    duplicatesInFile,
    skipped,
    unmatched: [...unmatched.values()].map((u) => ({ ...u, suggestions: suggest(u.name) })),
    ambiguous: [...ambiguous.values()].map((a) => ({
      name: a.name,
      candidates: a.candidates.map((id) => ({ id, name: displayName(byId.get(id)!) })),
    })),
    resolved: [...resolvedMap.values()],
    overwriteSample,
    accounts: accountRows.map((a) => ({ id: a.id, name: displayName(a) })),
    warnings,
  };
  return {
    preview,
    writes: pass3.map((r) => ({ accountId: r.accountId, date: r.date, balance: r.balance })),
    overwritten: overwriteCount,
  };
}

/** Dry run: zero writes. */
export async function previewBalanceImport(csvText: string, opts?: BalanceImportOptions): Promise<BalanceImportPreview> {
  return (await resolveBalanceImport(csvText, opts)).preview;
}

/**
 * Imports every valid row in one atomic batch. Skipped rows are reported, not
 * thrown; throws only on a missing/unparseable header or a size cap breach.
 * Both balance_history schemas (autoincrement id + unique index, or composite
 * PK) carry a unique (account_id, date), so the upsert never touches `id`.
 */
export async function commitBalanceImport(csvText: string, opts?: BalanceImportOptions): Promise<BalanceImportResult> {
  const plan = await resolveBalanceImport(csvText, opts);
  const { writes } = plan;
  if (writes.length) {
    await db.batch(
      writes.map((w) => ({
        sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
              ON CONFLICT(account_id, date) DO UPDATE SET balance = excluded.balance`,
        args: [w.accountId, w.balance, w.date],
      })),
      'write',
    );
    // executeTool also notifies for write tools; this covers non-tool callers.
    notifyChange();
  }
  return {
    inserted: writes.length - plan.overwritten,
    overwritten: plan.overwritten,
    skipped: plan.preview.skipped.length,
    accountsTouched: new Set(writes.map((w) => w.accountId)).size,
  };
}
