import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { saveCategoryRule, saveNameRule } from '../core/rules.js';
import { deleteAccount, importCsvTransactions } from '../core/accounts.js';
import { clearTransactionOverride, clearOverridesBulk } from '../core/transactions.js';

beforeEach(async () => {
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM name_rules');
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM accounts');
});

describe('saveCategoryRule with account scope', () => {
  it('persists account_id on insert', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });
    const row = (await db.execute('SELECT account_id, category FROM category_rules')).rows[0] as unknown as { account_id: string | null; category: string };
    expect(row.account_id).toBe('work');
    expect(row.category).toBe('Business Expenses');
  });

  it('allows the same pattern both globally and scoped (distinct rows)', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });
    const rows = (await db.execute('SELECT account_id, category FROM category_rules ORDER BY account_id IS NULL')).rows as unknown as { account_id: string | null; category: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.account_id === 'work')?.category).toBe('Business Expenses');
    expect(rows.find((r) => r.account_id === null)?.category).toBe('Shopping');
  });

  it('updates the existing global rule rather than inserting a duplicate', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Online', minAmount: null, maxAmount: null, accountId: null });
    const rows = (await db.execute('SELECT category FROM category_rules')).rows as unknown as { category: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Online');
  });
});

describe('deleteAccount removes its scoped rules', () => {
  it('deletes scoped category and name rules but leaves global ones', async () => {
    await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES ('work', 'Work Card', 'credit')", args: [] });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveNameRule({ pattern: 'amazon', matchType: 'name', replacement: 'Amazon Biz', minAmount: null, maxAmount: null, accountId: 'work' });

    await deleteAccount('work');

    const cat = (await db.execute('SELECT account_id FROM category_rules')).rows as unknown as { account_id: string | null }[];
    expect(cat).toHaveLength(1);
    expect(cat[0].account_id).toBeNull();
    const names = (await db.execute('SELECT account_id FROM name_rules')).rows as unknown as { account_id: string | null }[];
    expect(names).toHaveLength(0);
  });
});

describe('clearing manual overrides honors account-scoped rules', () => {
  async function insertTx(id: string, accountId: string, manualCategory: string | null = 'Manual') {
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, pending, ignored)
            VALUES (?, ?, '2025-01-01', 'AMAZON.COM', 25, ?, ?, 0, 0)`,
      args: [id, accountId, manualCategory ?? 'Uncategorized', manualCategory],
    });
  }

  it('clearTransactionOverride re-categorizes with the account-scoped rule', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });
    await insertTx('t1', 'work');

    await clearTransactionOverride('t1');

    const row = (await db.execute("SELECT category, manual_category FROM transactions WHERE id = 't1'")).rows[0] as unknown as { category: string; manual_category: string | null };
    expect(row.category).toBe('Business Expenses');
    expect(row.manual_category).toBeNull();
  });

  it('clearOverridesBulk applies each transaction\'s own account scope', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });
    await insertTx('t1', 'work');
    await insertTx('t2', 'home');

    await clearOverridesBulk(['t1', 't2']);

    const rows = (await db.execute('SELECT id, category FROM transactions ORDER BY id')).rows as unknown as { id: string; category: string }[];
    expect(rows.find((r) => r.id === 't1')?.category).toBe('Business Expenses');
    expect(rows.find((r) => r.id === 't2')?.category).toBe('Shopping');
  });
});

describe('importCsvTransactions honors account-scoped rules', () => {
  it('applies a rule scoped to the imported account', async () => {
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Shopping', minAmount: null, maxAmount: null, accountId: null });
    await saveCategoryRule({ pattern: 'amazon', matchType: 'name', category: 'Business Expenses', minAmount: null, maxAmount: null, accountId: 'work' });

    const rows = [['2025-01-01', 'AMAZON.COM', '25.00']];
    const result = await importCsvTransactions(rows, 'work', {
      amountMode: 'single', dateCol: 0, nameCol: 1, amountCol: 2, debitCol: null, creditCol: null, positiveIsInflow: false,
    }, { name: 'work.csv', hash: 'hash-work' });
    expect(result.imported).toBe(1);
    const tx = (await db.execute("SELECT category FROM transactions WHERE account_id = 'work'")).rows[0] as unknown as { category: string };
    expect(tx.category).toBe('Business Expenses');
  });
});
