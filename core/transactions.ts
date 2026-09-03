import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { rebuildDisplayNames } from './rename.js';
import { applyCategoriesToAll } from './categorize.js';
import { validateRegex } from './rule-utils.js';

// ── Single-transaction mutations ───────────────────────────────────────────────

export async function setTransactionCategory(id: string, category: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?',
    args: [category, category, id],
  });
}

export async function clearTransactionOverride(id: string): Promise<void> {
  const result = await db.execute({
    sql: 'SELECT account_id, name, merchant_name, raw_category, amount FROM transactions WHERE id = ?',
    args: [id],
  });
  if (result.rows.length === 0) return;
  const tx = result.rows[0] as unknown as {
    account_id: string; name: string; merchant_name: string | null; raw_category: string | null; amount: number;
  };
  const rules = await loadCategoryRules();
  const cat = categorizeWithRules(rules, tx.name, tx.merchant_name, tx.raw_category, tx.amount, tx.account_id);
  await db.execute({
    sql: 'UPDATE transactions SET category = ?, manual_category = NULL WHERE id = ?',
    args: [cat, id],
  });
}

/**
 * Reattribute a transaction to the period it belongs to. Preserves the bank's
 * posting date in `original_date` on the first edit, so repeated edits never
 * lose it and `clearTransactionDate` can always get back to the truth.
 */
export async function setTransactionDate(id: string, date: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE transactions SET original_date = COALESCE(original_date, date), date = ? WHERE id = ?',
    args: [date, id],
  });
}

export async function clearTransactionDate(id: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE transactions SET date = COALESCE(original_date, date), original_date = NULL WHERE id = ?',
    args: [id],
  });
}

export async function setTransactionIgnored(id: string, ignored: boolean): Promise<void> {
  await db.execute({
    sql: 'UPDATE transactions SET ignored = ? WHERE id = ?',
    args: [ignored ? 1 : 0, id],
  });
}

export async function setTransactionDisplayName(id: string, name: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE transactions SET display_name = ? WHERE id = ?',
    args: [name, id],
  });
}

export async function deleteTransaction(id: string): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM transaction_tags WHERE transaction_id = ?', args: [id] },
    { sql: 'DELETE FROM transactions WHERE id = ?', args: [id] },
  ], 'write');
}

// ── Rule upserts ───────────────────────────────────────────────────────────────

export async function upsertCategoryRule(
  pattern: string,
  matchType: 'name' | 'regex',
  category: string,
): Promise<number> {
  // Validate before any write: a persisted bad regex would throw inside every
  // later rule application (sync, import, re-categorize), not just this save.
  if (matchType === 'regex') validateRegex(pattern);
  const existing = await db.execute({
    sql: 'SELECT id FROM category_rules WHERE match_type = ? AND pattern = ?',
    args: [matchType, pattern],
  });
  if (existing.rows.length > 0) {
    const id = (existing.rows[0] as unknown as { id: number }).id;
    await db.execute({ sql: 'UPDATE category_rules SET category = ? WHERE id = ?', args: [category, id] });
  } else {
    await db.execute({
      sql: 'INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, ?, ?, ?)',
      args: [matchType, pattern, category],
    });
  }
  return applyCategoriesToAll();
}

export async function upsertNameRule(
  pattern: string,
  matchType: 'name' | 'regex',
  replacement: string,
): Promise<void> {
  if (matchType === 'regex') validateRegex(pattern);
  const existing = await db.execute({
    sql: 'SELECT id FROM name_rules WHERE match_type = ? AND pattern = ?',
    args: [matchType, pattern],
  });
  if (existing.rows.length > 0) {
    const id = (existing.rows[0] as unknown as { id: number }).id;
    await db.execute({ sql: 'UPDATE name_rules SET replacement = ? WHERE id = ?', args: [replacement, id] });
  } else {
    await db.execute({
      sql: 'INSERT INTO name_rules (match_type, pattern, replacement) VALUES (?, ?, ?)',
      args: [matchType, pattern, replacement],
    });
  }
  await rebuildDisplayNames();
}

// ── Bulk mutations ─────────────────────────────────────────────────────────────

export async function setTransactionCategoryBulk(ids: string[], category: string): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) => ({
      sql: 'UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?',
      args: [category, category, id],
    })),
    'write',
  );
}

export async function clearOverridesBulk(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const txRes = await db.execute({
    sql: `SELECT id, account_id, name, merchant_name, raw_category, amount FROM transactions WHERE id IN (${placeholders}) AND manual_category IS NOT NULL`,
    args: ids,
  });
  const rows = txRes.rows as unknown as {
    id: string; account_id: string; name: string; merchant_name: string | null;
    raw_category: string | null; amount: number;
  }[];
  if (rows.length === 0) return;
  const rules = await loadCategoryRules();
  await db.batch(
    rows.map((tx) => ({
      sql: 'UPDATE transactions SET category = ?, manual_category = NULL WHERE id = ?',
      args: [categorizeWithRules(rules, tx.name, tx.merchant_name, tx.raw_category, tx.amount, tx.account_id), tx.id],
    })),
    'write',
  );
}

export async function setIgnoredBulk(ids: string[], ignored: boolean): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) => ({
      sql: 'UPDATE transactions SET ignored = ? WHERE id = ?',
      args: [ignored ? 1 : 0, id],
    })),
    'write',
  );
}
