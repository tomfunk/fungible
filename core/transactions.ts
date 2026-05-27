import { db } from './db.js';
import { categorize, applyCategoriesToAll } from './categorize.js';
import { rebuildDisplayNames } from './rename.js';

// ── Single-transaction mutations ───────────────────────────────────────────────

export function setTransactionCategory(id: string, category: string): void {
  db.prepare('UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?').run(category, category, id);
}

export function clearTransactionOverride(id: string): void {
  const tx = db.prepare('SELECT name, merchant_name, raw_category, amount FROM transactions WHERE id = ?')
    .get(id) as { name: string; merchant_name: string | null; raw_category: string | null; amount: number } | undefined;
  if (!tx) return;
  const cat = categorize(tx.name, tx.merchant_name, tx.raw_category, tx.amount);
  db.prepare('UPDATE transactions SET category = ?, manual_category = NULL WHERE id = ?').run(cat, id);
}

export function setTransactionIgnored(id: string, ignored: boolean): void {
  db.prepare('UPDATE transactions SET ignored = ? WHERE id = ?').run(ignored ? 1 : 0, id);
}

export function setTransactionDisplayName(id: string, name: string): void {
  db.prepare('UPDATE transactions SET display_name = ? WHERE id = ?').run(name, id);
}

export function deleteTransaction(id: string): void {
  db.prepare('DELETE FROM transaction_tags WHERE transaction_id = ?').run(id);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

// ── Rule upserts ───────────────────────────────────────────────────────────────

/** Upsert a category rule and re-categorize all non-pinned transactions. Returns count updated. */
export function upsertCategoryRule(pattern: string, matchType: 'name' | 'regex', category: string): number {
  const existing = db.prepare('SELECT id FROM category_rules WHERE match_type = ? AND pattern = ?')
    .get(matchType, pattern) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE category_rules SET category = ? WHERE id = ?').run(category, existing.id);
  } else {
    db.prepare('INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, ?, ?, ?)')
      .run(matchType, pattern, category);
  }
  return applyCategoriesToAll();
}

/** Upsert a name rule and rebuild all display names. */
export function upsertNameRule(pattern: string, matchType: 'name' | 'regex', replacement: string): void {
  const existing = db.prepare('SELECT id FROM name_rules WHERE match_type = ? AND pattern = ?')
    .get(matchType, pattern) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE name_rules SET replacement = ? WHERE id = ?').run(replacement, existing.id);
  } else {
    db.prepare('INSERT INTO name_rules (match_type, pattern, replacement) VALUES (?, ?, ?)')
      .run(matchType, pattern, replacement);
  }
  rebuildDisplayNames();
}

// ── Bulk mutations ─────────────────────────────────────────────────────────────

export function setTransactionCategoryBulk(ids: string[], category: string): void {
  const stmt = db.prepare('UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?');
  for (const id of ids) stmt.run(category, category, id);
}

export function clearOverridesBulk(ids: string[]): void {
  const rows = db.prepare(
    `SELECT id, name, merchant_name, raw_category, amount FROM transactions WHERE id IN (${ids.map(() => '?').join(',')}) AND manual_category IS NOT NULL`
  ).all(...ids) as { id: string; name: string; merchant_name: string | null; raw_category: string | null; amount: number }[];
  const stmt = db.prepare('UPDATE transactions SET category = ?, manual_category = NULL WHERE id = ?');
  for (const tx of rows) stmt.run(categorize(tx.name, tx.merchant_name, tx.raw_category, tx.amount), tx.id);
}

export function setIgnoredBulk(ids: string[], ignored: boolean): void {
  const stmt = db.prepare('UPDATE transactions SET ignored = ? WHERE id = ?');
  for (const id of ids) stmt.run(ignored ? 1 : 0, id);
}
