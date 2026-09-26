import { db } from './db.js';
import { inAmountRange, matchesPattern, matchesNameOrMerchant } from './rule-utils.js';

export type TagMatchType = 'name' | 'regex' | 'all';

export type TagRule = {
  match_type: TagMatchType;
  pattern: string;
  tag_id: number;
  account_id: string | null;
  min_amount: number | null;
  max_amount: number | null;
};

/** Load tag rules from DB, highest priority first. */
export async function loadTagRules(): Promise<TagRule[]> {
  const result = await db.execute(
    'SELECT match_type, pattern, tag_id, account_id, min_amount, max_amount FROM tag_rules ORDER BY priority DESC, (account_id IS NULL) ASC, id ASC'
  );
  return result.rows as unknown as TagRule[];
}

/** Pure predicate: does this rule apply to the given transaction? */
export function tagRuleMatches(
  rule: TagRule,
  accountId: string | null,
  name: string,
  merchant: string | null,
  amount?: number,
): boolean {
  if (rule.account_id !== null && rule.account_id !== accountId) return false;
  if (!inAmountRange(amount, rule.min_amount, rule.max_amount)) return false;
  if (rule.match_type === 'all') return true;
  const haystacks = [name.toLowerCase()];
  if (merchant && merchant.toLowerCase() !== name.toLowerCase()) haystacks.push(merchant.toLowerCase());
  return matchesPattern(rule.pattern, rule.match_type, haystacks);
}

/**
 * Apply all tag rules to candidate transactions, inserting matching (tx, tag)
 * pairs. Pairs in `tag_rule_suppressions` (a human removed that rule-applied
 * tag) and pairs already present are skipped, so re-runs never re-add a removed
 * tag. Returns the number of newly inserted pairs.
 */
export async function applyTagRules(scope?: { txIds?: string[] }): Promise<number> {
  const rules = await loadTagRules();
  if (rules.length === 0) return 0;

  let txRes;
  if (scope?.txIds) {
    if (scope.txIds.length === 0) return 0;
    const placeholders = scope.txIds.map(() => '?').join(',');
    txRes = await db.execute({
      sql: `SELECT id, account_id, name, merchant_name, amount FROM transactions WHERE id IN (${placeholders})`,
      args: scope.txIds,
    });
  } else {
    txRes = await db.execute('SELECT id, account_id, name, merchant_name, amount FROM transactions');
  }
  const rows = txRes.rows as unknown as {
    id: string; account_id: string; name: string; merchant_name: string | null; amount: number;
  }[];
  if (rows.length === 0) return 0;

  // Pairs we must not (re-)create: human-suppressed removals + already-applied tags.
  const skip = new Set<string>();
  const key = (txId: string, tagId: number) => `${txId}\u0000${tagId}`;
  const supRes = await db.execute('SELECT transaction_id, tag_id FROM tag_rule_suppressions');
  for (const r of supRes.rows as unknown as { transaction_id: string; tag_id: number }[]) {
    skip.add(key(r.transaction_id, Number(r.tag_id)));
  }
  const existingRes = await db.execute('SELECT transaction_id, tag_id FROM transaction_tags');
  for (const r of existingRes.rows as unknown as { transaction_id: string; tag_id: number }[]) {
    skip.add(key(r.transaction_id, Number(r.tag_id)));
  }

  const inserts: { sql: string; args: (string | number)[] }[] = [];
  for (const tx of rows) {
    for (const rule of rules) {
      if (!tagRuleMatches(rule, tx.account_id, tx.name, tx.merchant_name, tx.amount)) continue;
      const k = key(tx.id, rule.tag_id);
      if (skip.has(k)) continue;
      skip.add(k); // guard against two rules pointing at the same tag
      inserts.push({
        sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)',
        args: [tx.id, rule.tag_id],
      });
    }
  }

  if (inserts.length > 0) await db.batch(inserts, 'write');
  return inserts.length;
}

/**
 * Count transactions a prospective tag rule would match (within its account
 * and amount scope). Used by the editors to surface the blast radius —
 * especially for `match_type = 'all'`, which tags every transaction in scope.
 */
export async function countTagRuleMatches(
  matchType: TagMatchType,
  pattern: string,
  accountId: string | null = null,
  minAmount: number | null = null,
  maxAmount: number | null = null,
): Promise<number> {
  if (matchType !== 'all' && !pattern) return 0;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (accountId !== null) { where.push('account_id = ?'); args.push(accountId); }
  if (minAmount !== null) { where.push('amount >= ?'); args.push(minAmount); }
  if (maxAmount !== null) { where.push('amount <= ?'); args.push(maxAmount); }

  if (matchType === 'all') {
    const sql = `SELECT COUNT(*) as c FROM transactions${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const res = await db.execute({ sql, args });
    return Number((res.rows[0] as unknown as { c: number }).c);
  }

  if (matchType === 'name') {
    const sql = `SELECT COUNT(*) as c FROM transactions WHERE (name LIKE ? OR COALESCE(merchant_name, '') LIKE ?)${where.length ? ' AND ' + where.join(' AND ') : ''}`;
    const res = await db.execute({ sql, args: [`%${pattern}%`, `%${pattern}%`, ...args] });
    return Number((res.rows[0] as unknown as { c: number }).c);
  }

  // regex: filter in JS
  try {
    const re = new RegExp(pattern, 'i');
    const sql = `SELECT name, merchant_name FROM transactions${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const res = await db.execute({ sql, args });
    const rows = res.rows as unknown as { name: string; merchant_name: string | null }[];
    return rows.filter((r) => matchesNameOrMerchant(re, r)).length;
  } catch {
    return 0;
  }
}
