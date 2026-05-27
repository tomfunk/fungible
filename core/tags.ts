import { db } from './db.js';

export type TagOption = { id: number; name: string };

// ── Tag CRUD ───────────────────────────────────────────────────────────────────

export function createTag(name: string): void {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
}

export function renameTag(id: number, name: string): void {
  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
}

export function deleteTag(id: number): void {
  db.prepare('DELETE FROM transaction_tags WHERE tag_id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
}

/** Get or create a tag by name and return its id. */
export function getOrCreateTag(name: string): number {
  createTag(name);
  return (db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number }).id;
}

/** Get all tags as simple id+name pairs (no count). */
export function getTagOptions(): TagOption[] {
  return db.prepare('SELECT id, name FROM tags ORDER BY name').all() as TagOption[];
}

// ── Tag-transaction links ──────────────────────────────────────────────────────

export function getTransactionTagIds(txId: string): Set<number> {
  const rows = db.prepare('SELECT tag_id FROM transaction_tags WHERE transaction_id = ?').all(txId) as { tag_id: number }[];
  return new Set(rows.map((r) => r.tag_id));
}

export function addTagToTransaction(txId: string, tagId: number): void {
  db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(txId, tagId);
}

export function removeTagFromTransaction(txId: string, tagId: number): void {
  db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?').run(txId, tagId);
}

export function addTagToTransactions(txIds: string[], tagId: number): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)');
  for (const id of txIds) stmt.run(id, tagId);
}
