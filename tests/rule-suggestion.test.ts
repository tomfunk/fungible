import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { suggestRuleForTransaction } from '../core/rules.js';

let txId = 0;
async function insertTx(opts: { name: string; merchant_name?: string | null; amount?: number; account_id?: string }) {
  txId++;
  const id = `tx${txId}`;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
          VALUES (?, ?, '2025-01-01', ?, ?, ?, 'Uncategorized', 0, 0)`,
    args: [id, opts.account_id ?? 'a', opts.name, opts.merchant_name ?? null, opts.amount ?? 10],
  });
  return id;
}

async function insertRule(opts: { pattern: string; matchType: 'name' | 'regex'; category: string }) {
  await db.execute({
    sql: 'INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, ?, ?, ?)',
    args: [opts.matchType, opts.pattern, opts.category],
  });
  const row = (await db.execute({ sql: 'SELECT id FROM category_rules WHERE pattern = ?', args: [opts.pattern] }))
    .rows[0] as unknown as { id: number };
  return row.id;
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM hidden_categories');
});

describe('suggestRuleForTransaction', () => {
  it('returns null when the category is unchanged', async () => {
    const id = await insertTx({ name: 'AMAZON MKTP' });
    const result = await suggestRuleForTransaction(id, 'Shopping', 'Shopping');
    expect(result).toBeNull();
  });

  it('returns null when the new category is hidden', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories (category) VALUES (?)', args: ['Transfer'] });
    const id = await insertTx({ name: 'VENMO PAYMENT' });
    const result = await suggestRuleForTransaction(id, 'Uncategorized', 'Transfer');
    expect(result).toBeNull();
  });

  it('suggests a clean rule when no existing rule matches', async () => {
    const id = await insertTx({ name: 'AMAZON MKTP', merchant_name: 'Amazon' });
    const result = await suggestRuleForTransaction(id, 'Uncategorized', 'Shopping');
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      pattern: 'Amazon',
      matchType: 'name',
      newCategory: 'Shopping',
      conflictingRule: null,
    });
    expect(result!.matchCount).toBeGreaterThanOrEqual(1);
  });

  it('returns null when an existing rule already matches and already has the new category', async () => {
    await insertRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping' });
    const id = await insertTx({ name: 'AMAZON MKTP', merchant_name: 'Amazon' });
    const result = await suggestRuleForTransaction(id, 'Uncategorized', 'Shopping');
    expect(result).toBeNull();
  });

  it('surfaces the conflicting rule when a differently-patterned rule already matches with a different category', async () => {
    // The existing rule's pattern ("AMZN MKTP") differs from this
    // transaction's own merchant_name ("Amazon") -- proves matching goes
    // through the real matcher (matchesPattern/categorizeWithRules logic),
    // not exact string comparison against merchant_name ?? name.
    const ruleId = await insertRule({ pattern: 'AMZN MKTP', matchType: 'name', category: 'Uncategorized' });
    const id = await insertTx({ name: 'AMZN MKTP W12', merchant_name: 'Amazon' });

    const result = await suggestRuleForTransaction(id, 'Uncategorized', 'Shopping');
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('Amazon'); // proposed pattern is still this tx's own merchant_name ?? name
    expect(result!.newCategory).toBe('Shopping');
    expect(result!.conflictingRule).toEqual({
      id: ruleId,
      pattern: 'AMZN MKTP',
      matchType: 'name',
      category: 'Uncategorized',
    });
  });
});
