import type { Client } from '@libsql/client';

type Row = Record<string, unknown>;

function plain(row: Row): Row {
  // libsql rows carry array-index aliases; copy only the named columns.
  const out: Row = {};
  for (const k of Object.keys(row)) out[k] = row[k];
  return out;
}

/** Full transactions row by id, or null if absent. */
export async function readTx(db: Client, id: string): Promise<Row | null> {
  const r = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [id] });
  return r.rows[0] ? plain(r.rows[0] as unknown as Row) : null;
}

/** Tag names attached to a transaction, sorted. */
export async function readTxTags(db: Client, id: string): Promise<string[]> {
  const r = await db.execute({
    sql: `SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
          WHERE tt.transaction_id = ? ORDER BY t.name`,
    args: [id],
  });
  return r.rows.map((x) => String(x.name));
}

/** Full accounts row by id, or null if absent. */
export async function readAccount(db: Client, id: string): Promise<Row | null> {
  const r = await db.execute({ sql: 'SELECT * FROM accounts WHERE id = ?', args: [id] });
  return r.rows[0] ? plain(r.rows[0] as unknown as Row) : null;
}

/** COUNT(*) of a table, optionally filtered by a raw WHERE clause (test-only; table/where are not escaped). */
export async function countRows(
  db: Client,
  table: string,
  where?: string,
  args: (string | number | null)[] = [],
): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`,
    args,
  });
  return Number(r.rows[0].n);
}
