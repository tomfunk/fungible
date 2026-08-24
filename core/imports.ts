import { db } from './db.js';

/**
 * Provenance for CSV imports: which file a transaction came from, when, and with
 * what column mapping — so an import can be undone or re-pointed at a different
 * account after the fact.
 *
 * The design turns on separating two things the old scheme conflated. A CSV
 * transaction's *identity* is now opaque and permanent (`csv-<importId>-<row>`),
 * while its *idempotency* lives in a separate `dedup_key` under a unique index.
 * That split is what makes both operations cheap:
 *
 *   - undo is a delete by import_id, with no key arithmetic;
 *   - moving an import to another account is an UPDATE of account_id, with no id
 *     rewrite, so transaction_tags and tag_rule_suppressions (both keyed by
 *     transaction id) are undisturbed.
 *
 * Plaid rows carry source='plaid' and no dedup_key — Plaid's own transaction_id
 * is already a stable identity, and the sync upsert already keys on it.
 */

export type ImportRow = {
  id: number;
  account_id: string;
  /** Account name at read time, '' when the account has since been deleted. */
  account_name: string;
  file_name: string;
  file_hash: string;
  imported_at: number;
  /** Data rows in the file, excluding the header. */
  row_count: number;
  /** Rows that became transactions when the file was imported. */
  imported: number;
  /** Rows rejected as unparseable or already present. */
  skipped: number;
  min_date: string | null;
  max_date: string | null;
  /**
   * Rows from this import still in the database. Lower than `imported` once sync
   * has deduplicated some of them against Plaid, or the user deleted rows by
   * hand — so the two numbers together say what happened without dedup having to
   * maintain a counter.
   */
  present: number;
};

// dedupKey and assignOrdinals live in core/csv.ts: initDb's one-time backfill
// needs them, and core/db.ts importing this module would close a cycle.
export { dedupKey, assignOrdinals } from './csv.js';

/** The transaction id for row `rowIndex` of import `importId`. Opaque and stable. */
export const importTxId = (importId: number, rowIndex: number) => `csv-${importId}-${rowIndex}`;

export type ImportConfigJson = Record<string, unknown>;

/**
 * Opens an import and returns its id. Written before the rows because the id is
 * part of every transaction id they get; counts are filled in by `closeImport`
 * once the outcome is known.
 */
export async function openImport(
  accountId: string,
  fileName: string,
  fileHash: string,
  rowCount: number,
  config: ImportConfigJson,
): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO imports (account_id, file_name, file_hash, imported_at, row_count, imported, skipped, config)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    args: [accountId, fileName, fileHash, Date.now(), rowCount, JSON.stringify(config)],
  });
  return Number(result.lastInsertRowid);
}

export async function closeImport(
  importId: number,
  counts: { imported: number; skipped: number; minDate: string | null; maxDate: string | null },
): Promise<void> {
  await db.execute({
    sql: 'UPDATE imports SET imported = ?, skipped = ?, min_date = ?, max_date = ? WHERE id = ?',
    args: [counts.imported, counts.skipped, counts.minDate, counts.maxDate, importId],
  });
}

export async function getImports(): Promise<ImportRow[]> {
  const result = await db.execute(`
    SELECT i.id, i.account_id, COALESCE(a.name, '') as account_name,
           i.file_name, i.file_hash, i.imported_at, i.row_count, i.imported, i.skipped,
           i.min_date, i.max_date,
           (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id) as present
    FROM imports i
    LEFT JOIN accounts a ON a.id = i.account_id
    ORDER BY i.imported_at DESC, i.id DESC
  `);
  return (result.rows as unknown as ImportRow[]).map((r) => ({
    ...r,
    id: Number(r.id),
    imported_at: Number(r.imported_at),
    row_count: Number(r.row_count),
    imported: Number(r.imported),
    skipped: Number(r.skipped),
    present: Number(r.present),
  }));
}

/** Every import of a file with these bytes, newest first. Empty when it is new. */
export async function getImportsOfFile(fileHash: string): Promise<ImportRow[]> {
  const all = await getImports();
  return all.filter((i) => i.file_hash === fileHash);
}

export type ImportImpact = {
  present: number;
  /** Rows carrying a category the user set by hand — lost on undo. */
  manualCategories: number;
  /** Rows the user renamed — lost on undo. */
  renamed: number;
  /** Rows with at least one tag — lost on undo. */
  tagged: number;
};

/** What an undo would destroy, for a confirmation prompt that can be specific. */
export async function getImportImpact(importId: number): Promise<ImportImpact> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) as present,
                 SUM(CASE WHEN manual_category IS NOT NULL THEN 1 ELSE 0 END) as manualCategories,
                 SUM(CASE WHEN display_name    IS NOT NULL THEN 1 ELSE 0 END) as renamed,
                 SUM(CASE WHEN EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id)
                     THEN 1 ELSE 0 END) as tagged
          FROM transactions t WHERE t.import_id = ?`,
    args: [importId],
  });
  const r = result.rows[0] as unknown as Record<string, number | null>;
  return {
    present: Number(r.present ?? 0),
    manualCategories: Number(r.manualCategories ?? 0),
    renamed: Number(r.renamed ?? 0),
    tagged: Number(r.tagged ?? 0),
  };
}

/**
 * Undoes an import: every transaction it created, and the record of it.
 *
 * Rows already removed by CSV-vs-Plaid deduplication are simply not there to
 * delete, which is the right outcome — the Plaid row they were folded into is
 * not this import's to remove.
 *
 * Child rows go first: transaction_tags has a foreign key to transactions, so
 * deleting a tagged transaction directly fails the constraint.
 * tag_rule_suppressions is keyed by transaction id too (no FK, but leaving it
 * behind orphans rows that would re-suppress a future import's tags).
 */
export async function deleteImport(importId: number): Promise<number> {
  const ids = (await db.execute({
    sql: 'SELECT id FROM transactions WHERE import_id = ?',
    args: [importId],
  })).rows as unknown as { id: string }[];

  if (ids.length === 0) {
    await db.execute({ sql: 'DELETE FROM imports WHERE id = ?', args: [importId] });
    return 0;
  }

  const args = ids.map((r) => r.id);
  const placeholders = args.map(() => '?').join(',');
  await db.batch([
    { sql: `DELETE FROM transaction_tags        WHERE transaction_id IN (${placeholders})`, args },
    { sql: `DELETE FROM tag_rule_suppressions   WHERE transaction_id IN (${placeholders})`, args },
    { sql: `DELETE FROM transactions            WHERE id IN (${placeholders})`, args },
    { sql: 'DELETE FROM imports WHERE id = ?', args: [importId] },
  ], 'write');
  return args.length;
}

export type MoveImportResult = {
  moved: number;
  /**
   * Rows dropped because the destination account already held the same
   * transaction — the case where the same statement was imported into both
   * accounts. Keeping the destination's copy preserves whatever categories and
   * tags were put on it.
   */
  displaced: number;
};

/**
 * Re-points an import at a different account, for the "imported into the wrong
 * account" fix.
 *
 * Transaction ids are unchanged, so tags and suppressions ride along untouched.
 * Rows that would collide with an existing transaction in the destination are
 * deleted rather than moved, because the unique index on (account_id,
 * dedup_key) cannot hold both and the destination's copy is the older one.
 *
 * Categories are deliberately *not* recomputed here: account-scoped category and
 * name rules mean the moved rows may now match different rules, but re-running
 * them would also overwrite categories the user set by hand. Callers that want
 * that should apply rules explicitly.
 */
export async function moveImport(importId: number, toAccountId: string): Promise<MoveImportResult> {
  const rows = (await db.execute({
    sql: `SELECT t.id, t.dedup_key,
                 EXISTS (SELECT 1 FROM transactions d
                         WHERE d.account_id = ? AND d.dedup_key = t.dedup_key AND d.id <> t.id) as collides
          FROM transactions t WHERE t.import_id = ?`,
    args: [toAccountId, importId],
  })).rows as unknown as { id: string; dedup_key: string | null; collides: number }[];

  const colliding = rows.filter((r) => Number(r.collides) === 1).map((r) => r.id);
  const moving = rows.filter((r) => Number(r.collides) !== 1).map((r) => r.id);

  const statements: { sql: string; args: (string | number)[] }[] = [];
  if (colliding.length > 0) {
    const ph = colliding.map(() => '?').join(',');
    statements.push(
      { sql: `DELETE FROM transaction_tags      WHERE transaction_id IN (${ph})`, args: colliding },
      { sql: `DELETE FROM tag_rule_suppressions WHERE transaction_id IN (${ph})`, args: colliding },
      { sql: `DELETE FROM transactions          WHERE id IN (${ph})`, args: colliding },
    );
  }
  if (moving.length > 0) {
    const ph = moving.map(() => '?').join(',');
    statements.push({
      sql: `UPDATE transactions SET account_id = ? WHERE id IN (${ph})`,
      args: [toAccountId, ...moving],
    });
  }
  statements.push({ sql: 'UPDATE imports SET account_id = ? WHERE id = ?', args: [toAccountId, importId] });

  await db.batch(statements, 'write');
  return { moved: moving.length, displaced: colliding.length };
}
