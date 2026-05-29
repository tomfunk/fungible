import { db } from './db.js';

export type TagOption = { id: number; name: string };

export async function createTag(name: string): Promise<void> {
  await db.execute({ sql: 'INSERT OR IGNORE INTO tags (name) VALUES (?)', args: [name] });
}

export async function renameTag(id: number, name: string): Promise<void> {
  await db.execute({ sql: 'UPDATE tags SET name = ? WHERE id = ?', args: [name, id] });
}

export async function deleteTag(id: number): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM transaction_tags WHERE tag_id = ?', args: [id] },
    { sql: 'DELETE FROM tags WHERE id = ?', args: [id] },
  ], 'write');
}

export async function getOrCreateTag(name: string): Promise<number> {
  await createTag(name);
  const result = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] });
  return Number((result.rows[0] as unknown as { id: number }).id);
}

export async function getTagOptions(): Promise<TagOption[]> {
  const result = await db.execute('SELECT id, name FROM tags ORDER BY name');
  return (result.rows as unknown as TagOption[]).map((r) => ({ id: Number(r.id), name: r.name }));
}

export async function getTransactionTagIds(txId: string): Promise<Set<number>> {
  const result = await db.execute({
    sql: 'SELECT tag_id FROM transaction_tags WHERE transaction_id = ?',
    args: [txId],
  });
  const rows = result.rows as unknown as { tag_id: number }[];
  return new Set(rows.map((r) => Number(r.tag_id)));
}

export async function addTagToTransaction(txId: string, tagId: number): Promise<void> {
  await db.execute({
    sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)',
    args: [txId, tagId],
  });
}

export async function removeTagFromTransaction(txId: string, tagId: number): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?',
    args: [txId, tagId],
  });
}

export async function addTagToTransactions(txIds: string[], tagId: number): Promise<void> {
  if (txIds.length === 0) return;
  await db.batch(
    txIds.map((id) => ({
      sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)',
      args: [id, tagId],
    })),
    'write',
  );
}
