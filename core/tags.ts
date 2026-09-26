import { db } from './db.js';
import { loadTagRules, tagRuleMatches } from './tag-rules.js';

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
    { sql: 'DELETE FROM tag_rules WHERE tag_id = ?', args: [id] },
    { sql: 'DELETE FROM tag_rule_suppressions WHERE tag_id = ?', args: [id] },
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

// A deliberate manual tag-add clears any suppression for that (tx, tag) pair,
// so tag rules may apply it again — this is the only way to undo a removal.
export async function addTagToTransaction(txId: string, tagId: number): Promise<void> {
  await addTagToTransactions([txId], tagId);
}

// Removing a tag records a suppression so tag rules don't re-add it — but only
// when a current rule actually applies this tag to this transaction. Most
// removals are manual corrections of manually/LLM-added tags; suppressing those
// would silently exclude the transaction from legitimate rules created later.
// Un-stick a suppression by manually adding the tag again.
export async function removeTagFromTransaction(txId: string, tagId: number): Promise<void> {
  const ops = [
    { sql: 'DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', args: [txId, tagId] as (string | number)[] },
  ];
  const txRes = await db.execute({
    sql: 'SELECT account_id, name, merchant_name, amount FROM transactions WHERE id = ?',
    args: [txId],
  });
  if (txRes.rows.length > 0) {
    const tx = txRes.rows[0] as unknown as {
      account_id: string; name: string; merchant_name: string | null; amount: number;
    };
    const rules = (await loadTagRules()).filter((r) => r.tag_id === tagId);
    if (rules.some((r) => tagRuleMatches(r, tx.account_id, tx.name, tx.merchant_name, tx.amount))) {
      ops.push({ sql: 'INSERT OR IGNORE INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: [txId, tagId] });
    }
  }
  await db.batch(ops, 'write');
}

export async function addTagToTransactions(txIds: string[], tagId: number): Promise<void> {
  if (txIds.length === 0) return;
  await db.batch(
    txIds.flatMap((id) => [
      { sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [id, tagId] },
      { sql: 'DELETE FROM tag_rule_suppressions WHERE transaction_id = ? AND tag_id = ?', args: [id, tagId] },
    ]),
    'write',
  );
}
