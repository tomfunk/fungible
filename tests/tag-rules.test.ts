import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { applyTagRules, tagRuleMatches, countTagRuleMatches, type TagRule } from '../core/tag-rules.js';
import { addTagToTransaction, removeTagFromTransaction, deleteTag, getTransactionTagIds } from '../core/tags.js';
import { saveTagRule, deleteTagRule } from '../core/rules.js';

let tagSeq = 0;
async function makeTag(name: string): Promise<number> {
  tagSeq++;
  await db.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: [name] });
  const r = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] });
  return Number((r.rows[0] as unknown as { id: number }).id);
}

let txSeq = 0;
async function insertTx(name: string, accountId = 'a', amount = 10): Promise<string> {
  txSeq++;
  const id = `tx${txSeq}`;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
          VALUES (?, ?, '2025-01-01', ?, ?, 'Uncategorized', 0, 0)`,
    args: [id, accountId, name, amount],
  });
  return id;
}

async function insertRule(r: Partial<TagRule> & { tag_id: number }): Promise<number> {
  const res = await db.execute({
    sql: 'INSERT INTO tag_rules (priority, match_type, pattern, tag_id, account_id, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [10, r.match_type ?? 'all', r.pattern ?? '', r.tag_id, r.account_id ?? null, r.min_amount ?? null, r.max_amount ?? null],
  });
  return Number(res.lastInsertRowid);
}

const hasTag = async (txId: string, tagId: number) => (await getTransactionTagIds(txId)).has(tagId);

beforeEach(async () => {
  txSeq = 0; tagSeq = 0;
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

describe('tagRuleMatches', () => {
  const rule = (over: Partial<TagRule>): TagRule => ({
    match_type: 'name', pattern: '', tag_id: 1, account_id: null, min_amount: null, max_amount: null, ...over,
  });

  it('name substring, case-insensitive', () => {
    expect(tagRuleMatches(rule({ match_type: 'name', pattern: 'amzn' }), 'a', 'AMZN Mktp US', null, 10)).toBe(true);
    expect(tagRuleMatches(rule({ match_type: 'name', pattern: 'amzn' }), 'a', 'Target', null, 10)).toBe(false);
  });

  it('regex against name and merchant', () => {
    expect(tagRuleMatches(rule({ match_type: 'regex', pattern: '^amzn' }), 'a', 'AMZN*123', null, 10)).toBe(true);
    expect(tagRuleMatches(rule({ match_type: 'regex', pattern: '^amzn' }), 'a', 'SQ', 'AMZN Digital', 10)).toBe(true);
  });

  it('all matches everything in scope', () => {
    expect(tagRuleMatches(rule({ match_type: 'all' }), 'a', 'anything', null, 10)).toBe(true);
  });

  it('account scope: null = any, specific = that account only', () => {
    expect(tagRuleMatches(rule({ match_type: 'all', account_id: null }), 'x', 'n', null, 10)).toBe(true);
    expect(tagRuleMatches(rule({ match_type: 'all', account_id: 'work' }), 'work', 'n', null, 10)).toBe(true);
    expect(tagRuleMatches(rule({ match_type: 'all', account_id: 'work' }), 'home', 'n', null, 10)).toBe(false);
  });

  it('amount range gates the match', () => {
    expect(tagRuleMatches(rule({ match_type: 'all', min_amount: 100 }), 'a', 'n', null, 50)).toBe(false);
    expect(tagRuleMatches(rule({ match_type: 'all', min_amount: 100 }), 'a', 'n', null, 150)).toBe(true);
  });
});

describe('applyTagRules', () => {
  it('backfills matching transactions in the account scope', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    const t2 = await insertTx('Lunch', 'home');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });

    const applied = await applyTagRules();
    expect(applied).toBe(1);
    expect(await hasTag(t1, tag)).toBe(true);
    expect(await hasTag(t2, tag)).toBe(false);
  });

  it('saveTagRule backfills existing transactions', async () => {
    const tag = await makeTag('Amazon');
    const t1 = await insertTx('AMZN Mktp');
    const t2 = await insertTx('Target');
    const applied = await saveTagRule({ matchType: 'name', pattern: 'amzn', tagId: tag, minAmount: null, maxAmount: null });
    expect(applied).toBe(1);
    expect(await hasTag(t1, tag)).toBe(true);
    expect(await hasTag(t2, tag)).toBe(false);
  });

  it('does not double-count already-applied tags on re-run', async () => {
    const tag = await makeTag('Work');
    await insertTx('Lunch', 'work');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    expect(await applyTagRules()).toBe(1);
    expect(await applyTagRules()).toBe(0);
  });
});

describe('stickiness (suppression)', () => {
  it('removed tag stays gone when rules re-run', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await applyTagRules();
    expect(await hasTag(t1, tag)).toBe(true);

    await removeTagFromTransaction(t1, tag);
    expect(await hasTag(t1, tag)).toBe(false);

    // simulate sync/import re-run scoped to the modified row
    await applyTagRules({ txIds: [t1] });
    expect(await hasTag(t1, tag)).toBe(false);
  });

  it('removing a manually-added tag (no rule applies it) records no suppression', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    // manual tag then removal, with no rule yet — a correction, not "keep rules away"
    await addTagToTransaction(t1, tag);
    await removeTagFromTransaction(t1, tag);

    const sup = await db.execute({ sql: 'SELECT 1 FROM tag_rule_suppressions WHERE transaction_id = ? AND tag_id = ?', args: [t1, tag] });
    expect(sup.rows.length).toBe(0);

    // a legit rule created later still applies
    await saveTagRule({ matchType: 'all', pattern: '', tagId: tag, minAmount: null, maxAmount: null, accountId: 'work' });
    expect(await hasTag(t1, tag)).toBe(true);
  });

  it('removing a tag a current rule applies records a suppression', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await applyTagRules();
    await removeTagFromTransaction(t1, tag);

    const sup = await db.execute({ sql: 'SELECT 1 FROM tag_rule_suppressions WHERE transaction_id = ? AND tag_id = ?', args: [t1, tag] });
    expect(sup.rows.length).toBe(1);
  });

  it('removing a tag whose rule is scoped to another account records no suppression', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'home');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await addTagToTransaction(t1, tag); // manual, out of rule scope
    await removeTagFromTransaction(t1, tag);

    const sup = await db.execute({ sql: 'SELECT 1 FROM tag_rule_suppressions WHERE transaction_id = ? AND tag_id = ?', args: [t1, tag] });
    expect(sup.rows.length).toBe(0);
  });

  it('manual re-add clears the suppression so rules apply again', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await applyTagRules();
    await removeTagFromTransaction(t1, tag);

    await addTagToTransaction(t1, tag); // undo
    expect(await hasTag(t1, tag)).toBe(true);
    const sup = await db.execute({ sql: 'SELECT 1 FROM tag_rule_suppressions WHERE transaction_id = ? AND tag_id = ?', args: [t1, tag] });
    expect(sup.rows.length).toBe(0);

    await applyTagRules({ txIds: [t1] }); // stays
    expect(await hasTag(t1, tag)).toBe(true);
  });
});

describe('rule lifecycle', () => {
  it('deleteTagRule leaves already-applied tags', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    const ruleId = await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await applyTagRules();
    await deleteTagRule(ruleId);
    expect(await hasTag(t1, tag)).toBe(true);
  });

  it('deleteTag clears its rules and suppressions', async () => {
    const tag = await makeTag('Work');
    const t1 = await insertTx('Lunch', 'work');
    await insertRule({ match_type: 'all', tag_id: tag, account_id: 'work' });
    await applyTagRules();
    await removeTagFromTransaction(t1, tag);

    await deleteTag(tag);
    const rules = await db.execute('SELECT COUNT(*) c FROM tag_rules');
    const sups = await db.execute('SELECT COUNT(*) c FROM tag_rule_suppressions');
    expect(Number((rules.rows[0] as unknown as { c: number }).c)).toBe(0);
    expect(Number((sups.rows[0] as unknown as { c: number }).c)).toBe(0);
  });
});

describe('countTagRuleMatches', () => {
  it('counts all-in-scope, name and regex', async () => {
    await insertTx('AMZN', 'work');
    await insertTx('Target', 'work');
    await insertTx('AMZN', 'home');
    expect(await countTagRuleMatches('all', '', 'work')).toBe(2);
    expect(await countTagRuleMatches('all', '', null)).toBe(3);
    expect(await countTagRuleMatches('name', 'amzn', null)).toBe(2);
    expect(await countTagRuleMatches('regex', '^amzn', 'work')).toBe(1);
  });

  it('respects min/max amount bounds like tagRuleMatches does', async () => {
    await insertTx('AMZN', 'work', 5);
    await insertTx('AMZN', 'work', 50);
    await insertTx('AMZN', 'work', 500);
    expect(await countTagRuleMatches('all', '', 'work', 10, null)).toBe(2);
    expect(await countTagRuleMatches('all', '', 'work', null, 100)).toBe(2);
    expect(await countTagRuleMatches('name', 'amzn', null, 10, 100)).toBe(1);
    expect(await countTagRuleMatches('regex', '^amzn', 'work', 501, null)).toBe(0);
  });
});

describe('countTagRuleMatches LIKE metacharacters (name type)', () => {
  const seed = async () => {
    await insertTx('100% Cash', 'work', 10);
    await insertTx('100X Cash', 'work', 10);
    await insertTx('a_b', 'work', 10);
    await insertTx('axb', 'work', 10);
    await insertTx('back\\slash', 'work', 10);
    await insertTx('a_b', 'home', 500);
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
            VALUES ('m1', 'work', '2025-01-01', 'Other', 'Cash Merchant', 10, 'Uncategorized', 0, 0)`,
      args: [],
    });
  };

  it.each([
    ['100%', 1],
    ['a_b', 2],
    ['back\\slash', 1],
    ['cash', 3],
  ])('pattern %j counts %i across accounts', async (pattern, expected) => {
    await seed();
    expect(await countTagRuleMatches('name', pattern, null)).toBe(expected);
  });

  it.each([['50%', 1], ['off_co', 1]])('merchant-only pattern %j counts %i', async (pattern, expected) => {
    for (const [id, m] of [['mm1', '50% Off_Co'], ['mm2', '50X OffXCo']]) {
      await db.execute({
        sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
              VALUES (?, 'work', '2025-01-01', 'Unrelated', ?, 10, 'Uncategorized', 0, 0)`,
        args: [id, m],
      });
    }
    expect(await countTagRuleMatches('name', pattern, null)).toBe(expected);
  });

  it('still applies account and amount filters with escaped patterns', async () => {
    await seed();
    expect(await countTagRuleMatches('name', 'a_b', 'work')).toBe(1);
    expect(await countTagRuleMatches('name', 'a_b', null, 100, null)).toBe(1);
    expect(await countTagRuleMatches('name', 'a_b', null, null, 100)).toBe(1);
    expect(await countTagRuleMatches('name', 'a_b', 'home', null, 100)).toBe(0);
  });

  it.each(['100%', 'a_b', 'back\\slash', 'cash', 'CASH', '%', '_'])(
    'count equals rows tagRuleMatches accepts for %j',
    async (pattern) => {
      await seed();
      const res = await db.execute('SELECT account_id, name, merchant_name, amount FROM transactions');
      const rows = res.rows as unknown as { account_id: string; name: string; merchant_name: string | null; amount: number }[];
      const rule: TagRule = { match_type: 'name', pattern, tag_id: 1, account_id: null, min_amount: null, max_amount: null };
      const real = rows.filter((r) => tagRuleMatches(rule, r.account_id, r.name, r.merchant_name, r.amount)).length;
      expect(await countTagRuleMatches('name', pattern, null)).toBe(real);
    },
  );
});

// Regression: an invalid regex must be rejected at save time. saveTagRule used
// to insert the row and only then hit the RegExp constructor inside
// applyTagRules — persisting a rule that made every later rule application
// (sync, import, tag removal's suppression check) throw.
describe('saveTagRule regex validation', () => {
  it('rejects an invalid regex without persisting the rule', async () => {
    const tagId = await makeTag('trip');
    await expect(
      saveTagRule({ matchType: 'regex', pattern: '(', tagId, minAmount: null, maxAmount: null }),
    ).rejects.toThrow(/Invalid regex/);
    const r = await db.execute('SELECT COUNT(*) as c FROM tag_rules');
    expect(Number((r.rows[0] as unknown as { c: number }).c)).toBe(0);
  });

  it('accepts a valid regex', async () => {
    const tagId = await makeTag('trip');
    await insertTx('AMZN Mktp');
    const count = await saveTagRule({ matchType: 'regex', pattern: '^amzn', tagId, minAmount: null, maxAmount: null });
    expect(count).toBe(1);
  });
});
