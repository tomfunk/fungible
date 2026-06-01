import { db } from './db.js';
import { inAmountRange, matchesPattern } from './rule-utils.js';

type Rule = {
  match_type: 'name' | 'regex';
  pattern: string;
  category: string;
  min_amount: number | null;
  max_amount: number | null;
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
): string {
  const haystacks = [name.toLowerCase()];
  if (merchant && merchant.toLowerCase() !== name.toLowerCase()) haystacks.push(merchant.toLowerCase());

  for (const rule of rules) {
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
    'SELECT match_type, pattern, category, min_amount, max_amount FROM category_rules ORDER BY priority DESC'
  );
  return result.rows as unknown as Rule[];
}

/** Categorize a single transaction (loads rules from DB). */
export async function categorize(
  name: string,
  merchant: string | null,
  plaidCategory: string | null,
  amount?: number,
): Promise<string> {
  const rules = await loadCategoryRules();
  return categorizeWithRules(rules, name, merchant, plaidCategory, amount);
}

/** Re-categorize all transactions without a manual override. Returns count updated. */
export async function applyCategoriesToAll(): Promise<number> {
  const rules = await loadCategoryRules();

  const txRes = await db.execute(
    'SELECT id, name, merchant_name, raw_category, amount, category FROM transactions WHERE manual_category IS NULL'
  );
  const rows = txRes.rows as unknown as {
    id: string; name: string; merchant_name: string | null;
    raw_category: string | null; amount: number; category: string;
  }[];

  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const tx of rows) {
    const cat = categorizeWithRules(rules, tx.name, tx.merchant_name, tx.raw_category, tx.amount);
    if (cat !== 'Uncategorized' && cat !== tx.category) {
      updates.push({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: [cat, tx.id] });
    }
  }

  if (updates.length > 0) await db.batch(updates, 'write');
  return updates.length;
}
