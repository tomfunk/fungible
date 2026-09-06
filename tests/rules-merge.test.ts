import { describe, it, expect } from 'vitest';

import type { Rule, NameRule } from '../core/queries.js';
import { mergeRules, ruleKey } from '../core/rules-merge.js';

function rule(over: Partial<Rule> & { id: number }): Rule {
  return {
    priority: 0,
    match_type: 'contains',
    pattern: 'amazon',
    category: 'Shopping',
    min_amount: null,
    max_amount: null,
    account_id: null,
    ...over,
  };
}

function nameRule(over: Partial<NameRule> & { id: number }): NameRule {
  return {
    match_type: 'contains',
    pattern: 'amazon',
    replacement: 'Amazon',
    min_amount: null,
    max_amount: null,
    account_id: null,
    ...over,
  };
}

/** Merges and asserts the invariants: rows == inputs - pairs, and keys unique. */
function expectInvariant(rules: Rule[], nameRules: NameRule[]) {
  const merged = mergeRules(rules, nameRules);
  const pairs = merged.filter((m) => m.categoryRuleId !== null && m.nameRuleId !== null).length;
  expect(merged.length).toBe(rules.length + nameRules.length - pairs);
  expect(new Set(merged.map((m) => m.key)).size).toBe(merged.length);
  return merged;
}

describe('ruleKey', () => {
  it('agrees across the two rule kinds when the five match fields match', () => {
    expect(ruleKey(rule({ id: 1 }))).toBe(ruleKey(nameRule({ id: 9 })));
  });

  it('separates the fields so a pattern cannot spill into the account', () => {
    const a = ruleKey(rule({ id: 1, pattern: 'a', account_id: 'b' }));
    const b = ruleKey(rule({ id: 2, pattern: 'ab', account_id: null }));
    expect(a).not.toBe(b);
  });

  it('keeps a null amount bound distinct from a zero bound', () => {
    expect(ruleKey(rule({ id: 1, min_amount: null }))).not.toBe(
      ruleKey(rule({ id: 2, min_amount: 0 })),
    );
  });
});

describe('mergeRules', () => {
  it('pairs a category rule and a name rule that describe the same row', () => {
    const merged = expectInvariant(
      [rule({ id: 1, priority: 5, category: 'Shopping' })],
      [nameRule({ id: 7, replacement: 'Amazon' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      pattern: 'amazon',
      matchType: 'contains',
      minAmount: null,
      maxAmount: null,
      accountId: null,
      category: 'Shopping',
      categoryRuleId: 1,
      priority: 5,
      replacement: 'Amazon',
      nameRuleId: 7,
    });
  });

  it('pairs on account and amount bounds, not just the pattern', () => {
    const merged = expectInvariant(
      [rule({ id: 1, account_id: 'acc1', min_amount: 10, max_amount: 20 })],
      [nameRule({ id: 7, account_id: 'acc1', min_amount: 10, max_amount: 20 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      accountId: 'acc1',
      minAmount: 10,
      maxAmount: 20,
      categoryRuleId: 1,
      nameRuleId: 7,
    });
  });

  it('leaves a category rule with no partner without a name side', () => {
    const merged = expectInvariant([rule({ id: 1, priority: 3 })], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      category: 'Shopping',
      categoryRuleId: 1,
      priority: 3,
      replacement: null,
      nameRuleId: null,
    });
  });

  it('leaves a name rule with no partner without a category side', () => {
    const merged = expectInvariant([], [nameRule({ id: 7 })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      replacement: 'Amazon',
      nameRuleId: 7,
      category: null,
      categoryRuleId: null,
      priority: null,
    });
  });

  it('does not pair a null amount bound with a zero bound', () => {
    const merged = expectInvariant(
      [rule({ id: 1, min_amount: null })],
      [nameRule({ id: 7, min_amount: 0 })],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ categoryRuleId: 1, nameRuleId: null, minAmount: null });
    expect(merged[1]).toMatchObject({ categoryRuleId: null, nameRuleId: 7, minAmount: 0 });
  });

  it('does not pair rules that differ only by account', () => {
    const merged = expectInvariant(
      [rule({ id: 1, account_id: null })],
      [nameRule({ id: 7, account_id: 'acc1' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => [m.categoryRuleId, m.nameRuleId])).toEqual([
      [1, null],
      [null, 7],
    ]);
  });

  it('gives a shared name rule to only the first of two duplicate category rules', () => {
    const merged = expectInvariant(
      [rule({ id: 1, category: 'Shopping' }), rule({ id: 2, category: 'Household' })],
      [nameRule({ id: 7 })],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ categoryRuleId: 1, nameRuleId: 7, replacement: 'Amazon' });
    expect(merged[1]).toMatchObject({ categoryRuleId: 2, nameRuleId: null, replacement: null });
  });

  it('pairs duplicate keys one-for-one when both sides have duplicates', () => {
    const merged = expectInvariant(
      [rule({ id: 1 }), rule({ id: 2 }), rule({ id: 3 })],
      [nameRule({ id: 7 }), nameRule({ id: 8 })],
    );
    expect(merged.map((m) => [m.categoryRuleId, m.nameRuleId])).toEqual([
      [1, 7],
      [2, 8],
      [3, null],
    ]);
  });

  it('keeps category-rule order, then appends leftover name rules in order', () => {
    const rules = [
      rule({ id: 1, pattern: 'a', priority: 9 }),
      rule({ id: 2, pattern: 'b', priority: 5 }),
      rule({ id: 3, pattern: 'c', priority: 1 }),
    ];
    const nameRules = [
      nameRule({ id: 7, pattern: 'z' }),
      nameRule({ id: 8, pattern: 'b' }),
      nameRule({ id: 9, pattern: 'y' }),
    ];
    const merged = expectInvariant(rules, nameRules);
    expect(merged.map((m) => m.pattern)).toEqual(['a', 'b', 'c', 'z', 'y']);
    expect(merged.map((m) => [m.categoryRuleId, m.nameRuleId])).toEqual([
      [1, null],
      [2, 8],
      [3, null],
      [null, 7],
      [null, 9],
    ]);
  });

  it('emits a unique, id-derived key per row', () => {
    const merged = expectInvariant(
      [rule({ id: 1 }), rule({ id: 2 })],
      [nameRule({ id: 7 }), nameRule({ id: 8, pattern: 'other' })],
    );
    expect(merged.map((m) => m.key)).toEqual(['1:7', '2:', ':8']);
  });

  it('returns an empty list when there are no rules at all', () => {
    expect(mergeRules([], [])).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const rules = [rule({ id: 1 })];
    const nameRules = [nameRule({ id: 7 })];
    mergeRules(rules, nameRules);
    expect(rules).toHaveLength(1);
    expect(nameRules).toHaveLength(1);
  });
});
