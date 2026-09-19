import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  /** Basename, not the full path: it identifies the import in the UI without
   *  storing where on disk the user keeps their statements. */
  fileName: string;
  /** Digest of the file's bytes, so re-picking a file that was already imported
   *  can be recognised before the user maps a single column. */
  fileHash: string;
};

export function parseCSV(filePath: string): ParsedCsv {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString('utf8').trim();
  const lines = text.split('\n');
  const parse = (line: string) =>
    line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g)?.map((v) => v.replace(/^"|"$/g, '').trim()) ?? [];
  const headers = parse(lines[0]);
  const rows = lines.slice(1).filter(Boolean).map(parse);
  return {
    headers,
    rows,
    fileName: path.basename(filePath),
    fileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export function parseDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) {
    const [m, d, y] = raw.split('/');
    const fullYear = y.length === 2 ? (parseInt(y) < 50 ? `20${y}` : `19${y}`) : y;
    return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return raw;
}

export function parseCurrencyAmount(raw: string): number {
  const s = raw.trim();
  const negative = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[$,()]/g, '');
  const value = parseFloat(cleaned);
  return negative ? -value : value;
}

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
