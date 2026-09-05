import type { Rule, NameRule } from './queries.js';

/**
 * One row of the unified rule list: a category rule, a name rule, or both when
 * the two describe the same match (see `ruleKey`).
 */
export type MergedRule = {
  /**
   * Stable row identity, unique within a merged list: the ids of the rules
   * behind the row, `categoryRuleId:nameRuleId` with a missing side left empty.
   * Not the pairing key (see `ruleKey`) -- two category rules can share that
   * one. Rule ids survive a reload, so this key survives a refresh too.
   */
  key: string;
  pattern: string;
  matchType: string;
  minAmount: number | null;
  maxAmount: number | null;
  accountId: string | null;
  /** null when this row has no category rule. */
  category: string | null;
  categoryRuleId: number | null;
  priority: number | null;
  /** null when this row has no name rule. */
  replacement: string | null;
  nameRuleId: number | null;
};

/** ASCII unit separator: cannot occur in a pattern or an account id. */
const SEP = '\u001f';

/**
 * A category rule and a name rule describe the same row when their match type,
 * pattern, account and amount bounds all agree. A null account/bound normalizes
 * to the empty string, which keeps null distinct from 0 (empty vs "0").
 */
export function ruleKey(r: {
  match_type: string;
  pattern: string;
  account_id: string | null;
  min_amount: number | null;
  max_amount: number | null;
}): string {
  return [
    r.match_type,
    r.pattern,
    r.account_id ?? '',
    r.min_amount === null ? '' : String(r.min_amount),
    r.max_amount === null ? '' : String(r.max_amount),
  ].join(SEP);
}

/**
 * Merges category rules and name rules into one list, pairing rows that share a
 * `ruleKey`. Every input appears exactly once: pairing consumes a name rule, so
 * two category rules with the same key and a single name rule available yield
 * one paired row and one category-only row.
 *
 * Ordering is stable, because a TUI cursor rides on it: rows derived from
 * `rules` come first in `rules` order, then the leftover name-only rows in
 * `nameRules` order.
 */
export function mergeRules(rules: Rule[], nameRules: NameRule[]): MergedRule[] {
  // A queue of name-rule indices per key, so each name rule is consumed by at
  // most one category rule.
  const pending = new Map<string, number[]>();
  nameRules.forEach((n, i) => {
    const key = ruleKey(n);
    const queue = pending.get(key);
    if (queue) queue.push(i);
    else pending.set(key, [i]);
  });

  const merged: MergedRule[] = [];
  const paired = new Array<boolean>(nameRules.length).fill(false);

  for (const r of rules) {
    const idx = pending.get(ruleKey(r))?.shift();
    const name = idx === undefined ? undefined : nameRules[idx];
    if (idx !== undefined) paired[idx] = true;
    merged.push({
      key: `${r.id}:${name ? name.id : ''}`,
      pattern: r.pattern,
      matchType: r.match_type,
      minAmount: r.min_amount,
      maxAmount: r.max_amount,
      accountId: r.account_id,
      category: r.category,
      categoryRuleId: r.id,
      priority: r.priority,
      replacement: name ? name.replacement : null,
      nameRuleId: name ? name.id : null,
    });
  }

  nameRules.forEach((n, i) => {
    if (paired[i]) return;
    merged.push({
      key: `:${n.id}`,
      pattern: n.pattern,
      matchType: n.match_type,
      minAmount: n.min_amount,
      maxAmount: n.max_amount,
      accountId: n.account_id,
      category: null,
      categoryRuleId: null,
      priority: null,
      replacement: n.replacement,
      nameRuleId: n.id,
    });
  });

  return merged;
}
