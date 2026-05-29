import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { applyNameRules, rebuildDisplayNames } from '../core/rename.js';

async function insertRule(match_type: string, pattern: string, replacement: string, min_amount: number | null, max_amount: number | null) {
  await db.execute({
    sql: 'INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount) VALUES (?, ?, ?, ?, ?)',
    args: [match_type, pattern, replacement, min_amount, max_amount],
  });
}

beforeEach(async () => {
  await db.execute('DELETE FROM name_rules');
  await db.execute('DELETE FROM transactions');
});

describe('applyNameRules', () => {
  it('returns original name when no rules exist', async () => {
    expect(await applyNameRules('STARBUCKS #12345')).toBe('STARBUCKS #12345');
    expect(await applyNameRules('AMZN*MKTP US')).toBe('AMZN*MKTP US');
  });

  describe('name match', () => {
    it('replaces when name contains pattern (case-insensitive)', async () => {
      await insertRule('name', 'starbucks', 'Starbucks', null, null);
      expect(await applyNameRules('STARBUCKS #12345')).toBe('Starbucks');
      expect(await applyNameRules('Starbucks Coffee')).toBe('Starbucks');
      expect(await applyNameRules('starbucks downtown')).toBe('Starbucks');
    });

    it('does not match when pattern not in name', async () => {
      await insertRule('name', 'starbucks', 'Starbucks', null, null);
      expect(await applyNameRules('COFFEE BEAN')).toBe('COFFEE BEAN');
    });
  });

  describe('regex match', () => {
    it('replaces on regex match', async () => {
      await insertRule('regex', '^AMZN\\*', 'Amazon', null, null);
      expect(await applyNameRules('AMZN*MKTP US')).toBe('Amazon');
      expect(await applyNameRules('AMZN*DIGITAL')).toBe('Amazon');
    });

    it('does not replace when regex does not match', async () => {
      await insertRule('regex', '^AMZN\\*', 'Amazon', null, null);
      expect(await applyNameRules('AMAZON MARKETPLACE')).toBe('AMAZON MARKETPLACE');
    });

    it('is case-insensitive', async () => {
      await insertRule('regex', 'netflix', 'Netflix', null, null);
      expect(await applyNameRules('NETFLIX.COM')).toBe('Netflix');
      expect(await applyNameRules('netflix monthly')).toBe('Netflix');
    });
  });

  describe('rule ordering', () => {
    it('first matching rule wins (ordered by id ASC)', async () => {
      await insertRule('name', 'venmo', 'Venmo Transfer', null, null);
      await insertRule('name', 'venmo', 'Phone Bill', null, null);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Venmo Transfer');
    });

    it('falls through to next rule when first does not match', async () => {
      await insertRule('name', 'zelle', 'Zelle', null, null);
      await insertRule('name', 'venmo', 'Venmo', null, null);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Venmo');
    });
  });

  describe('amount filtering', () => {
    it('skips rule when amount is below min_amount', async () => {
      await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 10.00)).toBe('VENMO PAYMENT');
    });

    it('skips rule when amount is above max_amount', async () => {
      await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 100.00)).toBe('VENMO PAYMENT');
    });

    it('applies rule when amount is exactly at min_amount (= max_amount)', async () => {
      await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 54.79)).toBe('Phone Bill');
    });

    it('applies rule when no amount provided (amount filter skipped)', async () => {
      await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Phone Bill');
    });

    it('applies rule when amount is in a range', async () => {
      await insertRule('name', 'check', 'Large Check', 1000, null);
      expect(await applyNameRules('CHECK #5678', 500)).toBe('CHECK #5678');
      expect(await applyNameRules('CHECK #5678', 1000)).toBe('Large Check');
      expect(await applyNameRules('CHECK #5678', 5000)).toBe('Large Check');
    });

    it('falls through to next rule when amount out of range', async () => {
      await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      await insertRule('name', 'venmo', 'Venmo', null, null);
      expect(await applyNameRules('VENMO PAYMENT', 100.00)).toBe('Venmo');
      expect(await applyNameRules('VENMO PAYMENT', 54.79)).toBe('Phone Bill');
    });
  });
});

describe('rebuildDisplayNames', () => {
  async function insertTx(id: string, name: string, amount: number) {
    await db.execute({
      sql: "INSERT INTO transactions (id, account_id, date, name, amount) VALUES (?, 'acct1', '2025-01-01', ?, ?)",
      args: [id, name, amount],
    });
  }

  it('returns the count of changed transactions', async () => {
    await insertRule('name', 'starbucks', 'Starbucks', null, null);
    await insertTx('tx1', 'STARBUCKS #1', 5.00);
    await insertTx('tx2', 'NETFLIX.COM', 15.99);
    expect(await rebuildDisplayNames()).toBe(1);
  });

  it('sets display_name for matching transactions', async () => {
    await insertRule('name', 'starbucks', 'Starbucks', null, null);
    await insertTx('tx1', 'STARBUCKS #1234', 5.00);
    await rebuildDisplayNames();
    const row = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: ['tx1'] })).rows[0] as unknown as { display_name: string | null };
    expect(row.display_name).toBe('Starbucks');
  });

  it('sets display_name to null when name is unchanged', async () => {
    await insertTx('tx1', 'SOME RANDOM STORE', 20.00);
    await rebuildDisplayNames();
    const row = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: ['tx1'] })).rows[0] as unknown as { display_name: string | null };
    expect(row.display_name).toBeNull();
  });

  it('respects amount filtering when rebuilding', async () => {
    await insertRule('name', 'venmo', 'Phone Bill', 54.79, 54.79);
    await insertTx('tx1', 'VENMO PAYMENT', 54.79);
    await insertTx('tx2', 'VENMO PAYMENT', 200.00);
    await rebuildDisplayNames();
    const tx1 = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: ['tx1'] })).rows[0] as unknown as { display_name: string | null };
    const tx2 = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: ['tx2'] })).rows[0] as unknown as { display_name: string | null };
    expect(tx1.display_name).toBe('Phone Bill');
    expect(tx2.display_name).toBeNull();
  });

  it('returns 0 when no display names change', async () => {
    await insertTx('tx1', 'COFFEE SHOP', 3.50);
    await insertTx('tx2', 'GAS STATION', 60.00);
    const count = await rebuildDisplayNames();
    expect(count).toBe(0);
    const tx1 = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: ['tx1'] })).rows[0] as unknown as { display_name: string | null };
    expect(tx1.display_name).toBeNull();
  });
});
