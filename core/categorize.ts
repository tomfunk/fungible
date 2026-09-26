import { db } from './db.js';
import { inAmountRange, matchesPattern } from './rule-utils.js';

type Rule = {
  match_type: 'name' | 'regex';
  pattern: string;
  category: string;
  min_amount: number | null;
  max_amount: number | null;
  account_id: string | null;
};

// Plaid's personal_finance_category → our simplified categories
const PLAID_CATEGORY_MAP: Record<string, string> = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  LOAN_PAYMENTS: 'Loan Payment',
  BANK_FEES: 'Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Government',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  'Merchandise': 'Shopping',
  'Gas/Automotive': 'Transportation',
  'Other Travel': 'Travel',
  'Payment/Credit': 'Transfer',
  'Other Services': 'Services',
  'Entertainment': 'Entertainment',
  'Utilities': 'Bills & Utilities',
  'Phone/Cable': 'Bills & Utilities',
  'Food & Dining': 'Food & Drink',
  'Groceries': 'Food & Drink',
  'Healthcare': 'Medical',
  'Personal': 'Personal Care',
  'Education': 'Services',
  'OTHER': 'Uncategorized',
};

/** Pure sync categorization using pre-loaded rules. */
export function categorizeWithRules(
  rules: Rule[],
  name: string,
  merchant: string | null,
  plaidCategory: string | null,
  amount?: number,
  accountId?: string | null,
): string {
  const haystacks = [name.toLowerCase()];
  if (merchant && merchant.toLowerCase() !== name.toLowerCase()) haystacks.push(merchant.toLowerCase());

  for (const rule of rules) {
    if (rule.account_id !== null && rule.account_id !== accountId) continue;
    if (!inAmountRange(amount, rule.min_amount, rule.max_amount)) continue;
    if (matchesPattern(rule.pattern, rule.match_type, haystacks)) return rule.category;
  }

  if (plaidCategory && PLAID_CATEGORY_MAP[plaidCategory]) {
    return PLAID_CATEGORY_MAP[plaidCategory];
  }

  return 'Uncategorized';
}

/** Load category rules from DB. */
export async function loadCategoryRules(): Promise<Rule[]> {
  const result = await db.execute(
    'SELECT match_type, pattern, category, min_amount, max_amount, account_id FROM category_rules ORDER BY priority DESC, (account_id IS NULL) ASC, id ASC'
  );
  return result.rows as unknown as Rule[];
}

/** Categorize a single transaction (loads rules from DB). */
export async function categorize(
  name: string,
  merchant: string | null,
  plaidCategory: string | null,
  amount?: number,
  accountId?: string | null,
): Promise<string> {
  const rules = await loadCategoryRules();
  return categorizeWithRules(rules, name, merchant, plaidCategory, amount, accountId);
}

/**
 * Re-categorize all transactions without a manual override. Returns count updated.
 *
 * `allowDowngradeToUncategorized` controls what happens to a transaction whose
 * recomputed category comes back 'Uncategorized' (no rule matched, and no Plaid
 * category fallback applies) while it currently holds some other category:
 *
 *  - false (default): leave it alone. This is the "a rule was just added or
 *    edited" case (add_rule, upsertCategoryRule, saveCategoryRule without
 *    deletion) — reapplying rules should only pick up new matches, not blank
 *    out unrelated rows that happen not to match anything right now.
 *  - true: apply the downgrade like any other change. This is the "a rule was
 *    just deleted" case (deleteCategoryRule) — rows that relied on the
 *    now-gone rule should revert to Uncategorized (or whatever lower-priority
 *    rule now applies) rather than keep showing a category nothing justifies
 *    anymore.
 */
export async function applyCategoriesToAll(allowDowngradeToUncategorized = false): Promise<number> {
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
    if (cat !== tx.category && (allowDowngradeToUncategorized || cat !== 'Uncategorized')) {
      updates.push({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: [cat, tx.id] });
    }
  }

  if (updates.length > 0) await db.batch(updates, 'write');
  return updates.length;
}
