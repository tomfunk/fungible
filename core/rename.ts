import { db } from './db.js';
import { inAmountRange, matchesPattern } from './rule-utils.js';

type NameRule = {
  match_type: 'name' | 'regex';
  pattern: string;
  replacement: string;
  min_amount: number | null;
  max_amount: number | null;
};

export async function loadNameRules(): Promise<NameRule[]> {
  const result = await db.execute(
    'SELECT match_type, pattern, replacement, min_amount, max_amount FROM name_rules ORDER BY id ASC'
  );
  return result.rows as unknown as NameRule[];
}

/** Pure sync name application using pre-loaded rules. */
export function applyNameRulesWithRules(rules: NameRule[], name: string, amount?: number): string {
  for (const rule of rules) {
    if (!inAmountRange(amount, rule.min_amount, rule.max_amount)) continue;
    if (matchesPattern(rule.pattern, rule.match_type, [name.toLowerCase()])) return rule.replacement;
  }
  return name;
}

/** Returns the display name for a transaction (loads rules from DB). */
export async function applyNameRules(name: string, amount?: number): Promise<string> {
  const rules = await loadNameRules();
  return applyNameRulesWithRules(rules, name, amount);
}

/** Re-apply all name rules to every transaction and update display_name. */
export async function rebuildDisplayNames(): Promise<number> {
  const rules = await loadNameRules();

  const txRes = await db.execute('SELECT id, name, amount, display_name FROM transactions');
  const rows = txRes.rows as unknown as {
    id: string; name: string; amount: number; display_name: string | null;
  }[];

  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const tx of rows) {
    const display = applyNameRulesWithRules(rules, tx.name, tx.amount);
    const newVal = display !== tx.name ? display : null;
    if (newVal !== tx.display_name) {
      updates.push({ sql: 'UPDATE transactions SET display_name = ? WHERE id = ?', args: [newVal, tx.id] });
    }
  }

  if (updates.length > 0) await db.batch(updates, 'write');
  return updates.length;
}
