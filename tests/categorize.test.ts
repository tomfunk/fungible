import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { categorize, applyCategoriesToAll } from '../core/categorize.js';

async function insertRule(priority: number, match_type: string, pattern: string, category: string, min_amount: number | null, max_amount: number | null) {
  await db.execute({
    sql: 'INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)',
    args: [priority, match_type, pattern, category, min_amount, max_amount],
  });
}

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

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM transactions');
});

describe('Plaid category fallback', () => {
  it('returns Uncategorized when no rules and no Plaid category', async () => {
    expect(await categorize('some purchase', null, null)).toBe('Uncategorized');
  });

  it('returns Uncategorized for unknown Plaid category', async () => {
    expect(await categorize('some purchase', null, 'UNKNOWN_CATEGORY')).toBe('Uncategorized');
  });

  it('maps known Plaid API categories', async () => {
    expect(await categorize('deposit', null, 'INCOME')).toBe('Income');
    expect(await categorize('coffee', null, 'FOOD_AND_DRINK')).toBe('Food & Drink');
    expect(await categorize('spotify', null, 'ENTERTAINMENT')).toBe('Entertainment');
    expect(await categorize('amazon', null, 'GENERAL_MERCHANDISE')).toBe('Shopping');
    expect(await categorize('rent', null, 'RENT_AND_UTILITIES')).toBe('Bills & Utilities');
    expect(await categorize('doctor', null, 'MEDICAL')).toBe('Medical');
    expect(await categorize('uber', null, 'TRANSPORTATION')).toBe('Transportation');
    expect(await categorize('hotel', null, 'TRAVEL')).toBe('Travel');
    expect(await categorize('transfer', null, 'TRANSFER_IN')).toBe('Transfer');
    expect(await categorize('transfer', null, 'TRANSFER_OUT')).toBe('Transfer');
  });

  it('maps Capital One CSV categories', async () => {
    expect(await categorize('amazon', null, 'Merchandise')).toBe('Shopping');
    expect(await categorize('gas', null, 'Gas/Automotive')).toBe('Transportation');
    expect(await categorize('flight', null, 'Other Travel')).toBe('Travel');
    expect(await categorize('utilities', null, 'Utilities')).toBe('Bills & Utilities');
    expect(await categorize('phone', null, 'Phone/Cable')).toBe('Bills & Utilities');
    expect(await categorize('food', null, 'Food & Dining')).toBe('Food & Drink');
    expect(await categorize('groceries', null, 'Groceries')).toBe('Food & Drink');
    expect(await categorize('doctor', null, 'Healthcare')).toBe('Medical');
    expect(await categorize('other', null, 'OTHER')).toBe('Uncategorized');
  });
});

describe('name-match rules', () => {
  it('matches transaction name case-insensitively', async () => {
    await insertRule(0, 'name', 'starbucks', 'Food & Drink', null, null);
    expect(await categorize('STARBUCKS #1234', null, null)).toBe('Food & Drink');
    expect(await categorize('Starbucks Coffee', null, null)).toBe('Food & Drink');
    expect(await categorize('starbucks downtown', null, null)).toBe('Food & Drink');
  });

  it('matches partial name (contains)', async () => {
    await insertRule(0, 'name', 'whole foods', 'Grocery', null, null);
    expect(await categorize('WHOLEFDS #123 AUSTIN TX', null, null)).toBe('Uncategorized'); // not a substring
    expect(await categorize('Whole Foods Market #123', null, null)).toBe('Grocery');
  });

  it('matches against merchant name when different from transaction name', async () => {
    await insertRule(0, 'name', 'whole foods', 'Grocery', null, null);
    expect(await categorize('WFM#0001 TX', 'Whole Foods Market', null)).toBe('Grocery');
  });

  it('does not match merchant name when same as transaction name', async () => {
    await insertRule(0, 'name', 'amazon', 'Shopping', null, null);
    expect(await categorize('amazon', 'amazon', null)).toBe('Shopping');
  });

  it('user rules beat Plaid fallback category', async () => {
    await insertRule(0, 'name', 'netflix', 'Subscriptions', null, null);
    expect(await categorize('Netflix.com', null, 'ENTERTAINMENT')).toBe('Subscriptions');
  });
});

describe('regex rules', () => {
  it('matches regex pattern case-insensitively', async () => {
    await insertRule(0, 'regex', 'netflix|hulu|spotify', 'Entertainment', null, null);
    expect(await categorize('NETFLIX.COM', null, null)).toBe('Entertainment');
    expect(await categorize('Hulu monthly', null, null)).toBe('Entertainment');
    expect(await categorize('SPOTIFY USA', null, null)).toBe('Entertainment');
    expect(await categorize('Amazon Prime', null, null)).toBe('Uncategorized');
  });

  it('matches regex against merchant name too', async () => {
    await insertRule(0, 'regex', '^amzn\\*', 'Shopping', null, null);
    expect(await categorize('AMZN*MKTP US', null, null)).toBe('Shopping');
    expect(await categorize('SQ *AMZN', 'AMZN*DIGITAL', null)).toBe('Shopping');
  });
});

describe('priority ordering', () => {
  it('higher priority rule wins', async () => {
    await insertRule(5, 'name', 'amazon', 'Shopping', null, null);
    await insertRule(10, 'name', 'amazon', 'Services', null, null);
    expect(await categorize('Amazon.com', null, null)).toBe('Services');
  });

  it('lower priority rule applies when higher does not match', async () => {
    await insertRule(10, 'name', 'starbucks', 'Coffee', null, null);
    await insertRule(5, 'name', 'amazon', 'Shopping', null, null);
    expect(await categorize('Amazon.com', null, null)).toBe('Shopping');
  });

  it('first rule (highest priority) wins among ties', async () => {
    await insertRule(0, 'name', 'venmo', 'Transfer', null, null);
    await insertRule(0, 'name', 'venmo', 'Phone Bill', null, null);
    expect(await categorize('VENMO PAYMENT', null, null)).toBe('Transfer');
  });
});

describe('amount filtering', () => {
  it('skips rule when amount is below min_amount', async () => {
    await insertRule(0, 'name', 'venmo', 'Phone Bill', 54.79, 54.79);
    expect(await categorize('VENMO PAYMENT', null, null, 10.00)).toBe('Uncategorized');
  });

  it('skips rule when amount is above max_amount', async () => {
    await insertRule(0, 'name', 'venmo', 'Phone Bill', 54.79, 54.79);
    expect(await categorize('VENMO PAYMENT', null, null, 100.00)).toBe('Uncategorized');
  });

  it('applies rule when amount is exactly at min_amount', async () => {
    await insertRule(0, 'name', 'venmo', 'Phone Bill', 54.79, 54.79);
    expect(await categorize('VENMO PAYMENT', null, null, 54.79)).toBe('Phone Bill');
  });

  it('applies rule when amount is in range', async () => {
    await insertRule(0, 'name', 'rent', 'Rent', 1000, 3000);
    expect(await categorize('ZELLE TO LANDLORD', null, null, 2000)).toBe('Uncategorized');
    await insertRule(0, 'name', 'zelle to landlord', 'Rent', 1000, 3000);
    expect(await categorize('ZELLE TO LANDLORD', null, null, 2000)).toBe('Rent');
    expect(await categorize('ZELLE TO LANDLORD', null, null, 500)).toBe('Uncategorized');
  });

  it('skips amount check when amount is undefined (rule applies unconditionally)', async () => {
    await insertRule(0, 'name', 'venmo', 'Phone Bill', 54.79, 54.79);
    expect(await categorize('VENMO PAYMENT', null, null, undefined)).toBe('Phone Bill');
  });

  it('applies min_amount only rule', async () => {
    await insertRule(0, 'name', 'check', 'Large Check', 500, null);
    expect(await categorize('CHECK #1234', null, null, 499)).toBe('Uncategorized');
    expect(await categorize('CHECK #1234', null, null, 500)).toBe('Large Check');
    expect(await categorize('CHECK #1234', null, null, 9999)).toBe('Large Check');
  });

  it('applies max_amount only rule', async () => {
    await insertRule(0, 'name', 'atm', 'Cash', null, 200);
    expect(await categorize('ATM WITHDRAWAL', null, null, 201)).toBe('Uncategorized');
    expect(await categorize('ATM WITHDRAWAL', null, null, 200)).toBe('Cash');
    expect(await categorize('ATM WITHDRAWAL', null, null, 1)).toBe('Cash');
  });

  it('falls through to next rule when amount out of range', async () => {
    await insertRule(0, 'name', 'venmo', 'Phone Bill', 54.79, 54.79);
    await insertRule(0, 'name', 'venmo', 'Transfer', null, null);
    expect(await categorize('VENMO PAYMENT', null, null, 200)).toBe('Transfer');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('applyCategoriesToAll', () => {
  it('re-categorizes non-pinned transactions and returns count', async () => {
    await insertRule(10, 'name', 'Spotify', 'Entertainment', null, null);
    const id1 = await insertTx('Spotify');
    const id2 = await insertTx('Netflix');
    const count = await applyCategoriesToAll();
    expect(count).toBe(1);
    const row = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id1] })).rows[0] as unknown as { category: string };
    expect(row.category).toBe('Entertainment');
    const row2 = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id2] })).rows[0] as unknown as { category: string };
    expect(row2.category).toBe('Uncategorized');
  });

  it('skips manually pinned transactions', async () => {
    await insertRule(10, 'name', 'Spotify', 'Entertainment', null, null);
    const id = await insertTx('Spotify', 'Music');
    await applyCategoriesToAll();
    const row = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string };
    expect(row.category).toBe('Uncategorized');
  });

  it('returns 0 when no transactions match any rule', async () => {
    const count = await applyCategoriesToAll();
    expect(count).toBe(0);
  });
});
