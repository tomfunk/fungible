import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { getExportRows, transactionsToCsv, exportTransactionsCsv, type ExportRow } from '../core/export.js';

let txId = 0;
async function insertTx(opts: {
  date?: string;
  name?: string;
  merchantName?: string | null;
  displayName?: string | null;
  amount: number;
  category?: string | null;
  pending?: number;
  ignored?: number;
  accountId?: string;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, display_name, amount, category, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `tx${txId}`,
      opts.accountId ?? 'acct1',
      opts.date ?? '2025-01-15',
      opts.name ?? 'Test Transaction',
      opts.merchantName ?? null,
      opts.displayName ?? null,
      opts.amount,
      opts.category ?? 'Shopping',
      opts.pending ?? 0,
      opts.ignored ?? 0,
    ],
  });
  return `tx${txId}`;
}

async function insertAccount(id: string, name: string, nickname: string | null = null) {
  await db.execute({
    sql: `INSERT INTO accounts (id, name, nickname, type) VALUES (?, ?, ?, 'depository')`,
    args: [id, name, nickname],
  });
}

async function tagTransaction(transactionId: string, tagName: string) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO tags (name) VALUES (?)', args: [tagName] });
  const tag = (await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [tagName] }))
    .rows[0] as unknown as { id: number };
  await db.execute({
    sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)',
    args: [transactionId, tag.id],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transaction_tags');
  await db.execute('DELETE FROM tags');
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM hidden_categories');
  await db.execute('DELETE FROM accounts');
});

// ──────────────────────────────────────────────────────────────────────
describe('getExportRows', () => {
  it('returns rows within the date range only', async () => {
    await insertTx({ date: '2025-01-01', amount: 10 });
    await insertTx({ date: '2025-02-15', amount: 20 });
    await insertTx({ date: '2025-03-01', amount: 30 });
    const rows = await getExportRows({ from: '2025-01-15', to: '2025-02-28' });
    expect(rows.map((r) => r.date)).toEqual(['2025-02-15']);
  });

  it('negates the stored sign — stored positive (outflow) exports negative (expense)', async () => {
    await insertTx({ amount: 42.5, date: '2025-01-05' }); // outflow/expense
    await insertTx({ amount: -100, date: '2025-01-06' });  // inflow/income
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r.amount]));
    expect(byDate['2025-01-05']).toBe(-42.5);
    expect(byDate['2025-01-06']).toBe(100);
  });

  it('does not cap results at 200 or 5000 — unlike getTransactions', async () => {
    for (let i = 0; i < 250; i++) {
      await insertTx({ date: '2025-01-01', amount: i, name: `Row ${i}` });
    }
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-01' });
    expect(rows).toHaveLength(250);
  });

  it('excludes hidden categories by default', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ amount: 10, category: 'Transfer' });
    await insertTx({ amount: 20, category: 'Shopping' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    expect(rows.map((r) => r.category)).toEqual(['Shopping']);
  });

  it('includes hidden categories when includeHidden is true', async () => {
    await db.execute({ sql: 'INSERT INTO hidden_categories VALUES (?)', args: ['Transfer'] });
    await insertTx({ amount: 10, category: 'Transfer' });
    await insertTx({ amount: 20, category: 'Shopping' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31', includeHidden: true });
    expect(rows.map((r) => r.category).sort()).toEqual(['Shopping', 'Transfer']);
  });

  it('includes ignored and pending transactions, flagged rather than dropped', async () => {
    await insertTx({ amount: 10, ignored: 1 });
    await insertTx({ amount: 20, pending: 1 });
    await insertTx({ amount: 30 });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.amount === -10)?.isIgnored).toBe(true);
    expect(rows.find((r) => r.amount === -20)?.isPending).toBe(true);
    expect(rows.find((r) => r.amount === -30)?.isIgnored).toBe(false);
    expect(rows.find((r) => r.amount === -30)?.isPending).toBe(false);
  });

  it('applies the shared Filter (categories/accounts/tags) dimensions', async () => {
    await insertTx({ amount: 10, category: 'Rent', accountId: 'acct1' });
    await insertTx({ amount: 20, category: 'Dining', accountId: 'acct2' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31', filter: { categories: ['Rent'] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Rent');

    const byAccount = await getExportRows({ from: '2025-01-01', to: '2025-01-31', filter: { accounts: ['acct2'] } });
    expect(byAccount).toHaveLength(1);
    expect(byAccount[0].category).toBe('Dining');
  });

  it('applies the search term using the same matcher as the Transactions screen', async () => {
    await insertTx({ amount: 10, name: 'Coffee Shop', date: '2025-01-05' });
    await insertTx({ amount: 20, name: 'Grocery Store', date: '2025-01-06' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31', search: 'coffee' });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Coffee Shop');
  });

  it('resolves the account column via COALESCE(nickname, name)', async () => {
    await insertAccount('acct1', 'Chase Checking', 'Main Checking');
    await insertAccount('acct2', 'Ally Savings');
    await insertTx({ amount: 10, accountId: 'acct1', date: '2025-01-05' });
    await insertTx({ amount: 20, accountId: 'acct2', date: '2025-01-06' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r.account]));
    expect(byDate['2025-01-05']).toBe('Main Checking');
    expect(byDate['2025-01-06']).toBe('Ally Savings');
  });

  it('joins multiple tags into a comma-separated string', async () => {
    const id = await insertTx({ amount: 10, date: '2025-01-05' });
    await tagTransaction(id, 'shared');
    await tagTransaction(id, 'reimbursable');
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    expect(rows[0].tags.split(', ').sort()).toEqual(['reimbursable', 'shared']);
  });

  it('leaves tags empty for untagged transactions', async () => {
    await insertTx({ amount: 10, date: '2025-01-05' });
    const rows = await getExportRows({ from: '2025-01-01', to: '2025-01-31' });
    expect(rows[0].tags).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('transactionsToCsv', () => {
  const row = (overrides: Partial<ExportRow> = {}): ExportRow => ({
    date: '2025-01-15',
    name: 'Coffee Shop',
    displayName: 'Coffee Shop',
    amount: -4.5,
    category: 'Dining',
    account: 'Checking',
    tags: '',
    isIgnored: false,
    isPending: false,
    ...overrides,
  });

  it('writes the expected header', () => {
    const csv = transactionsToCsv([]);
    expect(csv).toBe('date,name,display_name,amount,category,account,tags,is_ignored,is_pending\n');
  });

  it('serializes a plain row with no quoting needed', () => {
    const csv = transactionsToCsv([row()]);
    expect(csv).toBe(
      'date,name,display_name,amount,category,account,tags,is_ignored,is_pending\n'
      + '2025-01-15,Coffee Shop,Coffee Shop,-4.50,Dining,Checking,,false,false\n',
    );
  });

  it('quotes a field containing a comma and doubles internal quotes', () => {
    const csv = transactionsToCsv([row({ name: 'Trader Joe\'s, "The Best"', tags: 'a, b' })]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('"Trader Joe\'s, ""The Best"""');
    expect(dataLine).toContain('"a, b"');
  });

  it('quotes a field containing a newline', () => {
    const csv = transactionsToCsv([row({ name: 'Line1\nLine2' })]);
    expect(csv).toContain('"Line1\nLine2"');
  });

  it('formats amount to two decimal places, preserving sign', () => {
    const csv = transactionsToCsv([row({ amount: 1200 }), row({ amount: -3 })]);
    const lines = csv.trim().split('\n');
    expect(lines[1]).toContain(',1200.00,');
    expect(lines[2]).toContain(',-3.00,');
  });

  it('renders ignored/pending flags as literal true/false', () => {
    const csv = transactionsToCsv([row({ isIgnored: true, isPending: true })]);
    expect(csv.trim().split('\n')[1]).toMatch(/,true,true$/);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('exportTransactionsCsv', () => {
  it('fetches rows and serializes them in one call', async () => {
    await insertTx({ amount: 10, name: 'Test Transaction', date: '2025-01-05' });
    const csv = await exportTransactionsCsv({ from: '2025-01-01', to: '2025-01-31' });
    expect(csv).toBe(
      'date,name,display_name,amount,category,account,tags,is_ignored,is_pending\n'
      + '2025-01-05,Test Transaction,Test Transaction,-10.00,Shopping,,,false,false\n',
    );
  });
});
