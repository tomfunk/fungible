/**
 * Child process for multi-writer DB tests. Spawn via spawnWriter(); do not
 * import from a test.
 *
 * Env: FUNGIBLE_DATA_DIR (required, temp dir whose fungible.db already has the
 * test schema), WRITER_ID (default "w"), WRITER_BATCHES (default 150).
 *
 * Each iteration is one core `db.batch` of THREE statements that must land
 * together: a tag, a transaction, and a transaction_tags link. A consistent
 * database therefore has, per writer, rows in tags/transactions/links that
 * match exactly (tag `${id}-${i}` <-> tx `${id}-${i}` <-> one link).
 *
 * Prints one JSON line {id, ok, errors:[messages]} and exits 0 only if there
 * were no errors.
 */
import { db } from '../../core/db.js';

const id = process.env.WRITER_ID ?? 'w';
const n = Number(process.env.WRITER_BATCHES ?? 150);

let ok = 0;
const errors: string[] = [];

for (let i = 0; i < n; i++) {
  const key = `${id}-${i}`;
  try {
    await db.batch(
      [
        { sql: 'INSERT INTO tags (name) VALUES (?)', args: [key] },
        {
          sql: `INSERT INTO transactions (id, account_id, date, name, amount, source)
                VALUES (?, 'acct', '2026-01-01', ?, 1, 'manual')`,
          args: [key, key],
        },
        {
          sql: `INSERT INTO transaction_tags (transaction_id, tag_id)
                SELECT ?, id FROM tags WHERE name = ?`,
          args: [key, key],
        },
      ],
      'write',
    );
    ok++;
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
}

console.log(JSON.stringify({ id, ok, errors }));
process.exit(errors.length === 0 ? 0 : 1);
