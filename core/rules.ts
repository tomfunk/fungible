import { db } from './db.js';
import { categorize } from './categorize.js';
import { rebuildDisplayNames } from './rename.js';

// Applies all category rules to non-pinned transactions; returns count of changed rows.
function applyAll(): number {
  const rows = db.prepare(
    'SELECT id, name, merchant_name, raw_category, amount, category FROM transactions WHERE manual_category IS NULL',
  ).all() as { id: string; name: string; merchant_name: string | null; raw_category: string | null; amount: number; category: string }[];
  const update = db.prepare('UPDATE transactions SET category = ? WHERE id = ?');
  let count = 0;
  for (const tx of rows) {
    const cat = categorize(tx.name, tx.merchant_name, tx.raw_category, tx.amount);
    if (cat !== tx.category) { update.run(cat, tx.id); count++; }
  }
  return count;
}

export function getUncategorizedCount(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE category = 'Uncategorized'").get() as { c: number }).c;
}

export function deleteCategoryRule(id: number): void {
  db.prepare('DELETE FROM category_rules WHERE id = ?').run(id);
}

export function deleteNameRule(id: number): void {
  db.prepare('DELETE FROM name_rules WHERE id = ?').run(id);
  rebuildDisplayNames();
}

export type SaveCategoryRuleOpts = {
  pattern: string;
  matchType: 'name' | 'regex';
  category: string;
  minAmount: number | null;
  maxAmount: number | null;
  editingId?: number | null;
};

/** Upsert a category rule and re-apply rules to all transactions. Returns count of changed transactions. */
export function saveCategoryRule(opts: SaveCategoryRuleOpts): number {
  const { pattern, matchType, category, minAmount, maxAmount, editingId } = opts;
  if (editingId != null) {
    db.prepare('UPDATE category_rules SET match_type = ?, pattern = ?, category = ?, min_amount = ?, max_amount = ? WHERE id = ?')
      .run(matchType, pattern, category, minAmount, maxAmount, editingId);
  } else {
    const existing = db.prepare('SELECT id FROM category_rules WHERE match_type = ? AND pattern = ?')
      .get(matchType, pattern) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE category_rules SET category = ?, min_amount = ?, max_amount = ? WHERE id = ?')
        .run(category, minAmount, maxAmount, existing.id);
    } else {
      db.prepare('INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount) VALUES (10, ?, ?, ?, ?, ?)')
        .run(matchType, pattern, category, minAmount, maxAmount);
    }
  }
  return applyAll();
}

export type SaveNameRuleOpts = {
  pattern: string;
  matchType: 'name' | 'regex';
  replacement: string;
  minAmount: number | null;
  maxAmount: number | null;
  editingId?: number | null;
};

export function saveNameRule(opts: SaveNameRuleOpts): void {
  const { pattern, matchType, replacement, minAmount, maxAmount, editingId } = opts;
  if (editingId != null) {
    db.prepare('UPDATE name_rules SET match_type = ?, pattern = ?, replacement = ?, min_amount = ?, max_amount = ? WHERE id = ?')
      .run(matchType, pattern, replacement, minAmount, maxAmount, editingId);
  } else {
    db.prepare('INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount) VALUES (?, ?, ?, ?, ?)')
      .run(matchType, pattern, replacement, minAmount, maxAmount);
  }
  rebuildDisplayNames();
}

export function setCategoryFlexibility(name: string, flexibility: string | null): void {
  db.prepare('UPDATE categories SET flexibility = ? WHERE name = ?').run(flexibility, name);
}

export function createCategory(name: string): void {
  db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
}

export function deleteCategory(name: string): void {
  db.prepare("UPDATE transactions SET category = 'Uncategorized', manual_category = NULL WHERE category = ?").run(name);
  db.prepare('DELETE FROM hidden_categories WHERE category = ?').run(name);
  db.prepare('DELETE FROM categories WHERE name = ?').run(name);
}

export function renameCategory(oldName: string, newName: string): void {
  db.prepare('INSERT OR IGNORE INTO categories (name, flexibility) SELECT ?, flexibility FROM categories WHERE name = ?').run(newName, oldName);
  db.prepare('UPDATE transactions SET category = ? WHERE category = ?').run(newName, oldName);
  db.prepare('UPDATE transactions SET manual_category = ? WHERE manual_category = ?').run(newName, oldName);
  db.prepare('UPDATE category_rules SET category = ? WHERE category = ?').run(newName, oldName);
  db.prepare('UPDATE hidden_categories SET category = ? WHERE category = ?').run(newName, oldName);
  db.prepare('DELETE FROM categories WHERE name = ?').run(oldName);
}
