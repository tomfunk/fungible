import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { deleteCategoryRule, saveCategoryRule } from '../core/rules.js';
import { executeTool } from '../core/tools.js';

let txId = 0;
async function insertTx(name: string, manual_category?: string) {
  txId++;
  const id = `tx${txId}`;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, pending, ignored)
          VALUES (?, 'a', '2025-01-01', ?, 10, 'Uncategorized', ?, 0, 0)`,
    args: [id, name, manual_category ?? null],
  });
  return id;
}

async function categoryOf(id: string) {
  const row = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id] }))
    .rows[0] as unknown as { category: string };
  return row.category;
}

async function ruleIdFor(pattern: string) {
  const row = (await db.execute({ sql: 'SELECT id FROM category_rules WHERE pattern = ?', args: [pattern] }))
    .rows[0] as unknown as { id: number };
  return row.id;
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM transactions');
});

describe('deleteCategoryRule re-evaluates transactions', () => {
  it('reverts a transaction to Uncategorized when its only matching rule is deleted', async () => {
    const id = await insertTx('Spotify');
    await saveCategoryRule({ pattern: 'Spotify', matchType: 'name', category: 'Entertainment', minAmount: null, maxAmount: null });
    expect(await categoryOf(id)).toBe('Entertainment');

    const count = await deleteCategoryRule(await ruleIdFor('Spotify'));
    expect(count).toBe(1);
    expect(await categoryOf(id)).toBe('Uncategorized');
  });

  it('falls back to a lower-priority rule when the matching rule is deleted', async () => {
    const id = await insertTx('VENMO PAYMENT');
    await saveCategoryRule({ pattern: 'venmo', matchType: 'name', category: 'Transfer', minAmount: null, maxAmount: null });
    // Raise the first rule's priority so it wins, then add a fallback.
    await db.execute("UPDATE category_rules SET priority = 20 WHERE pattern = 'venmo'");
    await saveCategoryRule({ pattern: 'payment', matchType: 'name', category: 'Bills & Utilities', minAmount: null, maxAmount: null });
    expect(await categoryOf(id)).toBe('Transfer');

    await deleteCategoryRule(await ruleIdFor('venmo'));
    expect(await categoryOf(id)).toBe('Bills & Utilities');
  });

  it('leaves manually pinned transactions untouched', async () => {
    const id = await insertTx('Spotify', 'Music');
    await db.execute({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: ['Music', id] });
    await saveCategoryRule({ pattern: 'Spotify', matchType: 'name', category: 'Entertainment', minAmount: null, maxAmount: null });
    expect(await categoryOf(id)).toBe('Music');

    const count = await deleteCategoryRule(await ruleIdFor('Spotify'));
    expect(count).toBe(0);
    expect(await categoryOf(id)).toBe('Music');
  });
});

describe('delete_rule MCP tool re-evaluates transactions', () => {
  it('reverts a transaction to Uncategorized when the agent deletes its only matching rule', async () => {
    const id = await insertTx('Spotify');
    await saveCategoryRule({ pattern: 'Spotify', matchType: 'name', category: 'Entertainment', minAmount: null, maxAmount: null });
    expect(await categoryOf(id)).toBe('Entertainment');

    const out = await executeTool('delete_rule', { id: await ruleIdFor('Spotify') });
    expect(out).toContain('Recategorized 1 transactions');
    expect(await categoryOf(id)).toBe('Uncategorized');
  });
});
