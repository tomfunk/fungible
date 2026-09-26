import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { rebuildDisplayNames, applyNameRulesWithRules, loadNameRules } from './rename.js';
import { applyCategoriesToAll } from './categorize.js';
import { validateRegex } from './rule-utils.js';
import { applyTagRules } from './tag-rules.js';

/**
 * True when `s` is a real calendar date in YYYY-MM-DD form. Used by both the
 * `set_transaction_date` MCP wrapper and setTransactionDate itself.
 *
 * The round-trip check is deliberate: `Date.parse('2025-02-30')` does NOT
 * return NaN — V8 rolls the day over to March 2 — so a plain parse would wave
 * impossible days through. Re-serialising and comparing catches them.
 */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── Single-transaction mutations ───────────────────────────────────────────────

/**
 * Insert a hand-entered transaction — for a real bank transaction Plaid's
 * `transactionsSync` never reports (a genuine feed gap, not something our
 * sync lost), typed in directly.
 *
 * id: `manual-<uuid>`, parallel to the `manual-<timestamp>` namespace
 * `createManualAccount` already uses for manual accounts, and distinct from
 * `source`, which is the actual signal everything else reads.
 *
 * category is required and always written to both `category` and
 * `manual_category` — same as `setTransactionCategory` — so it's pinned from
 * the moment it's created and never overwritten by rule application. Because
 * category is always supplied, this deliberately does NOT fall through to
 * `categorizeWithRules` the way sync/CSV import do for feed-sourced rows.
 *
 * Still runs name rules and tag rules, same as a synced row, so a manual
 * entry isn't a second-class citizen for renaming/tagging.
 *
 * `accountId` is checked against `accounts` before inserting and rejected if
 * it doesn't currently exist — there's no enforced FK, so a typo'd id would
 * otherwise silently orphan the row. This is only about creation time: once
 * a manual row exists, its account can later be deleted out from under it
 * the same as any other transaction's, and the rest of the system already
 * tolerates that (dedup.ts's CANDIDATE_SQL uses a LEFT JOIN to accounts for
 * exactly this reason) — nothing extra is needed here for that case.
 */
export async function addTransaction(input: {
  accountId: string;
  date: string;
  name: string;
  amount: number;
  category: string;
  merchantName?: string;
}): Promise<string> {
  const { accountId, date, amount, category } = input;
  const name = input.name.trim();
  const merchantName = input.merchantName?.trim() || null;

  if (!isValidIsoDate(date)) {
    throw new Error(`Invalid transaction date "${date}": expected YYYY-MM-DD.`);
  }
  if (!name) {
    throw new Error('Transaction name is required.');
  }
  if (!category) {
    throw new Error('Transaction category is required.');
  }

  const acct = await db.execute({ sql: 'SELECT 1 FROM accounts WHERE id = ?', args: [accountId] });
  if (acct.rows.length === 0) {
    throw new Error(`No account with id ${accountId}.`);
  }

  const id = `manual-${randomUUID()}`;
  const nameRules = await loadNameRules();
  const displayName = applyNameRulesWithRules(nameRules, name, amount, accountId);

  await db.execute({
    sql: `INSERT INTO transactions
            (id, account_id, date, name, merchant_name, amount, category, raw_category,
             pending, manual_category, display_name, source, import_id, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 'manual', NULL, NULL)`,
    args: [
      id, accountId, date, name, merchantName, amount, category,
      category, displayName !== name ? displayName : null,
    ],
  });

  await applyTagRules({ txIds: [id] });
  return id;
}

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
 *
 * Rejects anything that isn't a real YYYY-MM-DD date: SQLite's date functions
 * would silently treat a malformed value as NULL, quietly dropping the row out
 * of every range query. Callers (MCP wrapper, GUI, TUI) guard too, but this is
 * the last line before the write.
 */
export async function setTransactionDate(id: string, date: string): Promise<void> {
  if (!isValidIsoDate(date)) {
    throw new Error(`Invalid transaction date "${date}": expected YYYY-MM-DD.`);
  }
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
