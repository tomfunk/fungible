import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokenizeCsvDetailed } from './csv-tokenize.js';

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  /** 1-based source line each data row starts on (parallel to `rows`); differs
   *  from index + 2 when the file has blank lines or quoted embedded newlines. */
  lines: number[];
  /** Basename, not the full path: it identifies the import in the UI without
   *  storing where on disk the user keeps their statements. */
  fileName: string;
  /** Digest of the file's bytes, so re-picking a file that was already imported
   *  can be recognised before the user maps a single column. */
  fileHash: string;
};

/** Pure text parser. Throws on an unterminated quote (silent data loss otherwise).
 *  Blank records are dropped; fields are trimmed. */
export function parseCsvText(text: string): Pick<ParsedCsv, 'headers' | 'rows' | 'lines'> {
  const { records, unterminatedQuoteLine } = tokenizeCsvDetailed(text);
  if (unterminatedQuoteLine !== null) {
    throw new Error(`CSV has an unterminated quote starting on line ${unterminatedQuoteLine}`);
  }
  // A single-field record that is empty/whitespace (including a bare "") is
  // treated as a blank line and dropped; multi-field records like `,,` are kept.
  const kept = records.filter((r) => !(r.fields.length === 1 && r.fields[0].trim() === ''));
  if (kept.length === 0) return { headers: [], rows: [], lines: [] };
  const trimmed = kept.map((r) => r.fields.map((f) => f.trim()));
  return { headers: trimmed[0], rows: trimmed.slice(1), lines: kept.slice(1).map((r) => r.line) };
}

export function parseCSV(filePath: string): ParsedCsv {
  const bytes = fs.readFileSync(filePath);
  return {
    ...parseCsvText(bytes.toString('utf8')),
    fileName: path.basename(filePath),
    fileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export { parseDate } from './csv-date.js';

/**
 * The idempotency key for a CSV transaction, scoped to an account by the unique
 * index on (account_id, dedup_key) rather than by being baked into the key.
 *
 * `ord` is the occurrence index of an otherwise identical (date, name, amount)
 * tuple *within the file being imported*. It is what allows two real $4.50
 * coffees on the same day to both land, while re-importing an overlapping
 * statement still recognises the rows it has already seen: the same file always
 * produces the same ordinals.
 *
 * Amount is reduced to integer cents rather than interpolated as a float, so the
 * key never depends on how a language happens to render 5.0 versus 5.
 */
export function dedupKey(date: string, name: string, amount: number, ord: number): string {
  return `${date}|${name.trim().toLowerCase()}|${Math.round(amount * 100)}|${ord}`;
}

/** Numbers each row with its occurrence index among identical rows, in file order. */
export function assignOrdinals<T extends { date: string; name: string; amount: number }>(
  rows: T[],
): (T & { ord: number })[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const bucket = dedupKey(r.date, r.name, r.amount, 0);
    const ord = seen.get(bucket) ?? 0;
    seen.set(bucket, ord + 1);
    return { ...r, ord };
  });
}

// generateTxId used to live here, hashing (mask|date|name|amount) into the
// transaction's primary key. That made identity and idempotency the same
// mechanism, with two consequences: two genuinely separate charges for the same
// amount at the same merchant on the same day collapsed into one row, and the
// key encoded the account, so a row could not be moved between accounts without
// being rewritten. core/imports.ts replaces it with an opaque id plus a separate
// dedup_key.
