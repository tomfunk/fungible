import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { rebuildDisplayNames } from './rename.js';
import { applyTagRules, type TagMatchType } from './tag-rules.js';
import { validateRegex, inAmountRange, matchesPattern, countPatternMatches } from './rule-utils.js';

async function applyAll(): Promise<number> {
  const rules = await loadCategoryRules();
  const txRes = await db.execute(
    'SELECT id, account_id, name, merchant_name, raw_category, amount, category FROM transactions WHERE manual_category IS NULL'
  );
  const rows = txRes.rows as unknown as {
    id: string; account_id: string; name: string; merchant_name: string | null;
    raw_category: string | null; amount: number; category: string;
  }[];

  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const tx of rows) {
    const cat = categorizeWithRules(rules, tx.name, tx.merchant_name, tx.raw_category, tx.amount, tx.account_id);
    if (cat !== tx.category) {
      updates.push({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: [cat, tx.id] });
    }
  }
  if (updates.length > 0) await db.batch(updates, 'write');
  return updates.length;
}

export async function getUncategorizedCount(): Promise<number> {
  const result = await db.execute("SELECT COUNT(*) as c FROM transactions WHERE category = 'Uncategorized'");
  return Number((result.rows[0] as unknown as { c: number }).c);
}

export async function deleteCategoryRule(id: number): Promise<number> {
  await db.execute({ sql: 'DELETE FROM category_rules WHERE id = ?', args: [id] });
  return applyAll();
}

export async function deleteNameRule(id: number): Promise<void> {
  await db.execute({ sql: 'DELETE FROM name_rules WHERE id = ?', args: [id] });
  await rebuildDisplayNames();
}

export type SaveCategoryRuleOpts = {
  pattern: string;
  matchType: 'name' | 'regex';
  category: string;
  minAmount: number | null;
  maxAmount: number | null;
  accountId?: string | null;
  editingId?: number | null;
};

export async function saveCategoryRule(opts: SaveCategoryRuleOpts): Promise<number> {
  const { pattern, matchType, category, minAmount, maxAmount, accountId = null, editingId } = opts;
  // Validate before any write: a persisted bad regex would throw inside every
  // later rule application (sync, import, re-categorize), not just this save.
  if (matchType === 'regex') validateRegex(pattern);
  if (editingId != null) {
    await db.execute({
      sql: 'UPDATE category_rules SET match_type = ?, pattern = ?, category = ?, min_amount = ?, max_amount = ?, account_id = ? WHERE id = ?',
      args: [matchType, pattern, category, minAmount, maxAmount, accountId, editingId],
    });
  } else {
    const existing = await db.execute({
      sql: 'SELECT id FROM category_rules WHERE match_type = ? AND pattern = ? AND account_id IS ?',
      args: [matchType, pattern, accountId],
    });
    if (existing.rows.length > 0) {
      const id = (existing.rows[0] as unknown as { id: number }).id;
      await db.execute({
        sql: 'UPDATE category_rules SET category = ?, min_amount = ?, max_amount = ? WHERE id = ?',
        args: [category, minAmount, maxAmount, id],
      });
    } else {
      await db.execute({
        sql: 'INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount, account_id) VALUES (10, ?, ?, ?, ?, ?, ?)',
        args: [matchType, pattern, category, minAmount, maxAmount, accountId],
      });
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
  accountId?: string | null;
  editingId?: number | null;
};

export async function saveNameRule(opts: SaveNameRuleOpts): Promise<void> {
  const { pattern, matchType, replacement, minAmount, maxAmount, accountId = null, editingId } = opts;
  if (matchType === 'regex') validateRegex(pattern);
  if (editingId != null) {
    await db.execute({
      sql: 'UPDATE name_rules SET match_type = ?, pattern = ?, replacement = ?, min_amount = ?, max_amount = ?, account_id = ? WHERE id = ?',
      args: [matchType, pattern, replacement, minAmount, maxAmount, accountId, editingId],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount, account_id) VALUES (?, ?, ?, ?, ?, ?)',
      args: [matchType, pattern, replacement, minAmount, maxAmount, accountId],
    });
  }
  await rebuildDisplayNames();
}

export async function deleteTagRule(id: number): Promise<void> {
  // Leaves already-applied tags in place (mirrors category-rule delete).
  await db.execute({ sql: 'DELETE FROM tag_rules WHERE id = ?', args: [id] });
}

export type SaveTagRuleOpts = {
  matchType: TagMatchType;
  pattern: string;
  tagId: number;
  minAmount: number | null;
  maxAmount: number | null;
  accountId?: string | null;
  editingId?: number | null;
};

export async function saveTagRule(opts: SaveTagRuleOpts): Promise<number> {
  const { matchType, pattern, tagId, minAmount, maxAmount, accountId = null, editingId } = opts;
  if (matchType === 'regex') validateRegex(pattern);
  const normPattern = matchType === 'all' ? '' : pattern;
  if (editingId != null) {
    await db.execute({
      sql: 'UPDATE tag_rules SET match_type = ?, pattern = ?, tag_id = ?, min_amount = ?, max_amount = ?, account_id = ? WHERE id = ?',
      args: [matchType, normPattern, tagId, minAmount, maxAmount, accountId, editingId],
    });
  } else {
    const existing = await db.execute({
      sql: 'SELECT id FROM tag_rules WHERE match_type = ? AND pattern = ? AND account_id IS ? AND tag_id = ?',
      args: [matchType, normPattern, accountId, tagId],
    });
    if (existing.rows.length > 0) {
      const id = (existing.rows[0] as unknown as { id: number }).id;
      await db.execute({
        sql: 'UPDATE tag_rules SET min_amount = ?, max_amount = ? WHERE id = ?',
        args: [minAmount, maxAmount, id],
      });
    } else {
      await db.execute({
        sql: 'INSERT INTO tag_rules (priority, match_type, pattern, tag_id, min_amount, max_amount, account_id) VALUES (10, ?, ?, ?, ?, ?, ?)',
        args: [matchType, normPattern, tagId, minAmount, maxAmount, accountId],
      });
    }
  }
  return applyTagRules();
}

export async function setCategoryFlexibility(name: string, flexibility: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE categories SET flexibility = ? WHERE name = ?', args: [flexibility, name] });
}

export async function createCategory(name: string): Promise<void> {
  await db.execute({ sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)', args: [name] });
}

export async function deleteCategory(name: string): Promise<void> {
  await db.batch([
    { sql: "UPDATE transactions SET category = 'Uncategorized', manual_category = NULL WHERE category = ?", args: [name] },
    { sql: 'DELETE FROM hidden_categories WHERE category = ?', args: [name] },
    { sql: 'DELETE FROM categories WHERE name = ?', args: [name] },
  ], 'write');
}

// ── Post-manual-edit rule suggestion (#181) ────────────────────────────────

export interface RuleSuggestion {
  pattern: string;
  matchType: 'name';
  newCategory: string;
  matchCount: number;
  conflictingRule: { id: number; pattern: string; matchType: 'name' | 'regex'; category: string } | null;
}

type RuleRow = {
  id: number;
  match_type: 'name' | 'regex';
  pattern: string;
  category: string;
  min_amount: number | null;
  max_amount: number | null;
  account_id: string | null;
};

/**
 * After a user manually recategorizes a transaction, decide whether to offer
 * "always categorize MERCHANT as CATEGORY?" — read-only, does not write
 * anything. The caller (tui/gui) applies the suggestion via the existing
 * upsertCategoryRule (clean case) or saveCategoryRule with editingId (conflict
 * case) — the same write paths the manual "type a pattern to save as rule"
 * flow already uses.
 */
export async function suggestRuleForTransaction(
  transactionId: string,
  oldCategory: string,
  newCategory: string,
): Promise<RuleSuggestion | null> {
  if (newCategory === oldCategory) return null;

  const hiddenRes = await db.execute({
    sql: 'SELECT 1 FROM hidden_categories WHERE category = ?',
    args: [newCategory],
  });
  if (hiddenRes.rows.length > 0) return null;

  const txRes = await db.execute({
    sql: 'SELECT account_id, name, merchant_name, amount FROM transactions WHERE id = ?',
    args: [transactionId],
  });
  if (txRes.rows.length === 0) return null;
  const tx = txRes.rows[0] as unknown as {
    account_id: string; name: string; merchant_name: string | null; amount: number;
  };

  const pattern = tx.merchant_name ?? tx.name;
  if (!pattern) return null;

  // Same haystack construction categorizeWithRules uses, so matching a rule
  // here means the same rule would apply during normal categorization.
  const haystacks = [tx.name.toLowerCase()];
  if (tx.merchant_name && tx.merchant_name.toLowerCase() !== tx.name.toLowerCase()) {
    haystacks.push(tx.merchant_name.toLowerCase());
  }

  const rulesRes = await db.execute(
    'SELECT id, match_type, pattern, category, min_amount, max_amount, account_id FROM category_rules ORDER BY priority DESC, (account_id IS NULL) ASC, id ASC'
  );
  const rules = rulesRes.rows as unknown as RuleRow[];

  let conflictingRule: RuleSuggestion['conflictingRule'] = null;
  for (const rule of rules) {
    if (rule.account_id !== null && rule.account_id !== tx.account_id) continue;
    if (!inAmountRange(tx.amount, rule.min_amount, rule.max_amount)) continue;
    if (matchesPattern(rule.pattern, rule.match_type, haystacks)) {
      if (rule.category === newCategory) return null; // already covered
      conflictingRule = { id: rule.id, pattern: rule.pattern, matchType: rule.match_type, category: rule.category };
      break;
    }
  }

  const matchCount = await countPatternMatches(pattern, 'name');

  return { pattern, matchType: 'name', newCategory, matchCount, conflictingRule };
}

export async function renameCategory(oldName: string, newName: string): Promise<void> {
  await db.batch([
    { sql: 'INSERT OR IGNORE INTO categories (name, flexibility) SELECT ?, flexibility FROM categories WHERE name = ?', args: [newName, oldName] },
    { sql: 'UPDATE transactions SET category = ? WHERE category = ?', args: [newName, oldName] },
    { sql: 'UPDATE transactions SET manual_category = ? WHERE manual_category = ?', args: [newName, oldName] },
    { sql: 'UPDATE category_rules SET category = ? WHERE category = ?', args: [newName, oldName] },
    { sql: 'UPDATE hidden_categories SET category = ? WHERE category = ?', args: [newName, oldName] },
    { sql: 'DELETE FROM categories WHERE name = ?', args: [oldName] },
  ], 'write');
}
