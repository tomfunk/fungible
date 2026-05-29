import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
});

import { db } from '../core/db.js';
import { applyNameRules, rebuildDisplayNames } from '../core/rename.js';

const insertRule = (db as any).prepare(
  'INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount) VALUES (?, ?, ?, ?, ?)'
);

beforeEach(() => {
  (db as any).exec('DELETE FROM name_rules');
  (db as any).exec('DELETE FROM transactions');
});

describe('applyNameRules', () => {
  it('returns original name when no rules exist', async () => {
    expect(await applyNameRules('STARBUCKS #12345')).toBe('STARBUCKS #12345');
    expect(await applyNameRules('AMZN*MKTP US')).toBe('AMZN*MKTP US');
  });

  describe('name match', () => {
    it('replaces when name contains pattern (case-insensitive)', async () => {
      insertRule.run('name', 'starbucks', 'Starbucks', null, null);
      expect(await applyNameRules('STARBUCKS #12345')).toBe('Starbucks');
      expect(await applyNameRules('Starbucks Coffee')).toBe('Starbucks');
      expect(await applyNameRules('starbucks downtown')).toBe('Starbucks');
    });

    it('does not match when pattern not in name', async () => {
      insertRule.run('name', 'starbucks', 'Starbucks', null, null);
      expect(await applyNameRules('COFFEE BEAN')).toBe('COFFEE BEAN');
    });
  });

  describe('regex match', () => {
    it('replaces on regex match', async () => {
      insertRule.run('regex', '^AMZN\\*', 'Amazon', null, null);
      expect(await applyNameRules('AMZN*MKTP US')).toBe('Amazon');
      expect(await applyNameRules('AMZN*DIGITAL')).toBe('Amazon');
    });

    it('does not replace when regex does not match', async () => {
      insertRule.run('regex', '^AMZN\\*', 'Amazon', null, null);
      expect(await applyNameRules('AMAZON MARKETPLACE')).toBe('AMAZON MARKETPLACE');
    });

    it('is case-insensitive', async () => {
      insertRule.run('regex', 'netflix', 'Netflix', null, null);
      expect(await applyNameRules('NETFLIX.COM')).toBe('Netflix');
      expect(await applyNameRules('netflix monthly')).toBe('Netflix');
    });
  });

  describe('rule ordering', () => {
    it('first matching rule wins (ordered by id ASC)', async () => {
      insertRule.run('name', 'venmo', 'Venmo Transfer', null, null);
      insertRule.run('name', 'venmo', 'Phone Bill', null, null);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Venmo Transfer');
    });

    it('falls through to next rule when first does not match', async () => {
      insertRule.run('name', 'zelle', 'Zelle', null, null);
      insertRule.run('name', 'venmo', 'Venmo', null, null);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Venmo');
    });
  });

  describe('amount filtering', () => {
    it('skips rule when amount is below min_amount', async () => {
      insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 10.00)).toBe('VENMO PAYMENT');
    });

    it('skips rule when amount is above max_amount', async () => {
      insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 100.00)).toBe('VENMO PAYMENT');
    });

    it('applies rule when amount is exactly at min_amount (= max_amount)', async () => {
      insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT', 54.79)).toBe('Phone Bill');
    });

    it('applies rule when no amount provided (amount filter skipped)', async () => {
      insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      expect(await applyNameRules('VENMO PAYMENT')).toBe('Phone Bill');
    });

    it('applies rule when amount is in a range', async () => {
      insertRule.run('name', 'check', 'Large Check', 1000, null);
      expect(await applyNameRules('CHECK #5678', 500)).toBe('CHECK #5678');
      expect(await applyNameRules('CHECK #5678', 1000)).toBe('Large Check');
      expect(await applyNameRules('CHECK #5678', 5000)).toBe('Large Check');
    });

    it('falls through to next rule when amount out of range', async () => {
      insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
      insertRule.run('name', 'venmo', 'Venmo', null, null);
      expect(await applyNameRules('VENMO PAYMENT', 100.00)).toBe('Venmo');
      expect(await applyNameRules('VENMO PAYMENT', 54.79)).toBe('Phone Bill');
    });
  });
});

describe('rebuildDisplayNames', () => {
  const insertTx = (id: string, name: string, amount: number) => {
    (db as any).prepare(
      "INSERT INTO transactions (id, account_id, date, name, amount) VALUES (?, 'acct1', '2025-01-01', ?, ?)"
    ).run(id, name, amount);
  };

  it('returns the count of changed transactions', async () => {
    insertRule.run('name', 'starbucks', 'Starbucks', null, null);
    insertTx('tx1', 'STARBUCKS #1', 5.00);
    insertTx('tx2', 'NETFLIX.COM', 15.99);
    expect(await rebuildDisplayNames()).toBe(1);
  });

  it('sets display_name for matching transactions', async () => {
    insertRule.run('name', 'starbucks', 'Starbucks', null, null);
    insertTx('tx1', 'STARBUCKS #1234', 5.00);
    await rebuildDisplayNames();
    const row = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get('tx1') as any;
    expect(row.display_name).toBe('Starbucks');
  });

  it('sets display_name to null when name is unchanged', async () => {
    insertTx('tx1', 'SOME RANDOM STORE', 20.00);
    await rebuildDisplayNames();
    const row = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get('tx1') as any;
    expect(row.display_name).toBeNull();
  });

  it('respects amount filtering when rebuilding', async () => {
    insertRule.run('name', 'venmo', 'Phone Bill', 54.79, 54.79);
    insertTx('tx1', 'VENMO PAYMENT', 54.79);
    insertTx('tx2', 'VENMO PAYMENT', 200.00);
    await rebuildDisplayNames();
    const tx1 = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get('tx1') as any;
    const tx2 = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get('tx2') as any;
    expect(tx1.display_name).toBe('Phone Bill');
    expect(tx2.display_name).toBeNull();
  });

  it('returns 0 when no display names change', async () => {
    insertTx('tx1', 'COFFEE SHOP', 3.50);
    insertTx('tx2', 'GAS STATION', 60.00);
    const count = await rebuildDisplayNames();
    expect(count).toBe(0);
    const tx1 = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get('tx1') as any;
    expect(tx1.display_name).toBeNull();
  });
});
