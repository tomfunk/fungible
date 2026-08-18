import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { deduplicateCsvVsPlaid, getCsvPlaidDupeCandidates } from '../core/dedup.js';

let seq = 0;
async function csvTx(opts: { name: string; amount: number; date?: string; accountId?: string }) {
  seq++;
  const id = `csv-${seq}`;
  await db.execute({
    sql: "INSERT INTO transactions (id, account_id, date, name, amount, pending, ignored, source) VALUES (?, ?, ?, ?, ?, 0, 0, 'csv')",
    args: [id, opts.accountId ?? 'acct1', opts.date ?? '2025-01-15', opts.name, opts.amount],
  });
  return id;
}
async function plaidTx(opts: { name: string; amount: number; date?: string; accountId?: string }) {
  seq++;
  const id = `plaid-${seq}`;
  await db.execute({
    sql: "INSERT INTO transactions (id, account_id, date, name, amount, pending, ignored, source) VALUES (?, ?, ?, ?, ?, 0, 0, 'plaid')",
    args: [id, opts.accountId ?? 'acct1', opts.date ?? '2025-01-15', opts.name, opts.amount],
  });
  return id;
}
async function exists(id: string) {
  return (await db.execute({ sql: 'SELECT 1 FROM transactions WHERE id = ?', args: [id] })).rows.length > 0;
}

beforeEach(async () => {
  seq = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM accounts');
});

describe('deduplicateCsvVsPlaid', () => {
  it('returns 0 when no transactions', async () => {
    expect(await deduplicateCsvVsPlaid()).toBe(0);
  });

  it('returns 0 when only CSV transactions (no Plaid to match against)', async () => {
    await csvTx({ name: 'Amazon', amount: 50 });
    await csvTx({ name: 'Starbucks', amount: 5 });
    expect(await deduplicateCsvVsPlaid()).toBe(0);
  });

  it('returns 0 when only Plaid transactions', async () => {
    await plaidTx({ name: 'Amazon', amount: 50 });
    expect(await deduplicateCsvVsPlaid()).toBe(0);
  });

  describe('name matching', () => {
    it('removes CSV on exact name match', async () => {
      const csv = await csvTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'STARBUCKS', amount: 5 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('removes CSV when Plaid name is a substring of CSV name', async () => {
      const csv = await csvTx({ name: "Paper Payment to Albany Children's Center", amount: 200 });
      await plaidTx({ name: "Albany Children's Center", amount: 200 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('removes CSV when CSV name is a substring of Plaid name', async () => {
      const csv = await csvTx({ name: 'WHOLE FOODS', amount: 87.50 });
      await plaidTx({ name: 'WHOLE FOODS MARKET #123', amount: 87.50 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('handles Plaid masked names (MERCHANT* prefix)', async () => {
      const csv = await csvTx({ name: 'WHOLEFDS', amount: 87.50 });
      await plaidTx({ name: 'WHOLE*0001', amount: 87.50 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('matches masked Plaid name when prefix clearly identifies merchant', async () => {
      const csv = await csvTx({ name: 'COSTCO GAS #123', amount: 75.00 });
      await plaidTx({ name: 'COSTCO*WHSE 0001', amount: 75.00 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('does not match when names are completely different', async () => {
      await csvTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'AMAZON', amount: 5 });
      expect(await deduplicateCsvVsPlaid()).toBe(0);
    });
  });

  describe('amount matching', () => {
    it('does not deduplicate when amounts differ', async () => {
      await csvTx({ name: 'STARBUCKS', amount: 5.00 });
      await plaidTx({ name: 'STARBUCKS', amount: 5.50 });
      expect(await deduplicateCsvVsPlaid()).toBe(0);
    });

    it('deduplicates when amounts match exactly', async () => {
      const csv = await csvTx({ name: 'AMAZON', amount: 29.99 });
      await plaidTx({ name: 'AMAZON', amount: 29.99 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });
  });

  describe('date matching', () => {
    it('deduplicates when dates match exactly', async () => {
      const csv = await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-15' });
      await plaidTx({ name: 'AMAZON', amount: 50, date: '2025-01-15' });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('deduplicates when dates are within 3 days', async () => {
      const csv = await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-15' });
      await plaidTx({ name: 'AMAZON', amount: 50, date: '2025-01-18' });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });

    it('does not deduplicate when date difference exceeds 3 days', async () => {
      await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-15' });
      await plaidTx({ name: 'AMAZON', amount: 50, date: '2025-01-19' });
      expect(await deduplicateCsvVsPlaid()).toBe(0);
    });
  });

  describe('account matching', () => {
    it('does not deduplicate when accounts differ', async () => {
      await csvTx({ name: 'AMAZON', amount: 50, accountId: 'acct1' });
      await plaidTx({ name: 'AMAZON', amount: 50, accountId: 'acct2' });
      expect(await deduplicateCsvVsPlaid()).toBe(0);
    });

    it('deduplicates when accounts match', async () => {
      const csv = await csvTx({ name: 'AMAZON', amount: 50, accountId: 'chase' });
      await plaidTx({ name: 'AMAZON', amount: 50, accountId: 'chase' });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
    });
  });

  describe('source enforcement', () => {
    it('only removes CSV-sourced transactions, never Plaid', async () => {
      const plaid = await plaidTx({ name: 'AMAZON', amount: 50 });
      await csvTx({ name: 'AMAZON', amount: 50 });
      await deduplicateCsvVsPlaid();
      expect(await exists(plaid)).toBe(true);
    });

  });

  // Every criterion in MATCH_SQL is satisfied by two genuinely separate visits to
  // the same merchant in the same week, so the join is many-to-many and matching
  // "everything that matched" throws away real transactions.
  describe('one-to-one pairing', () => {
    it('lets one Plaid row absorb only one of two identical CSV rows', async () => {
      const csv1 = await csvTx({ name: 'STARBUCKS', amount: 5 });
      const csv2 = await csvTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'STARBUCKS', amount: 5 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      // Earliest CSV row is the one consumed, so the outcome is deterministic
      // when a file contains literally identical rows.
      expect(await exists(csv1)).toBe(false);
      expect(await exists(csv2)).toBe(true);
    });

    it('absorbs both CSV rows when Plaid reported both purchases', async () => {
      const csv1 = await csvTx({ name: 'STARBUCKS', amount: 5 });
      const csv2 = await csvTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'STARBUCKS', amount: 5 });
      expect(await deduplicateCsvVsPlaid()).toBe(2);
      expect(await exists(csv1)).toBe(false);
      expect(await exists(csv2)).toBe(false);
    });

    it('leaves surplus Plaid rows alone when the CSV has fewer', async () => {
      const csv = await csvTx({ name: 'STARBUCKS', amount: 5 });
      const plaid1 = await plaidTx({ name: 'STARBUCKS', amount: 5 });
      const plaid2 = await plaidTx({ name: 'STARBUCKS', amount: 5 });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(csv)).toBe(false);
      expect(await exists(plaid1)).toBe(true);
      expect(await exists(plaid2)).toBe(true);
    });

    it('pairs the stronger name match ahead of the closer date', async () => {
      const fuzzy = await csvTx({ name: 'STARBUCKS STORE 4471', amount: 5, date: '2025-01-15' });
      const exact = await csvTx({ name: 'STARBUCKS', amount: 5, date: '2025-01-17' });
      await plaidTx({ name: 'STARBUCKS', amount: 5, date: '2025-01-15' });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(exact)).toBe(false);
      expect(await exists(fuzzy)).toBe(true);
    });

    it('pairs the closer date when the names are equally strong', async () => {
      const far  = await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-18' });
      const near = await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-16' });
      await plaidTx({ name: 'AMAZON', amount: 50, date: '2025-01-15' });
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await exists(near)).toBe(false);
      expect(await exists(far)).toBe(true);
    });

    it('reports the same pairing to the review list that it would delete', async () => {
      const csv1 = await csvTx({ name: 'STARBUCKS', amount: 5 });
      await csvTx({ name: 'STARBUCKS', amount: 5 });
      await plaidTx({ name: 'STARBUCKS', amount: 5 });
      const pairs = await getCsvPlaidDupeCandidates();
      expect(pairs.map((p) => p.csvId)).toEqual([csv1]);
    });
  });

  describe('candidate list', () => {
    it('carries the account name', async () => {
      await db.execute({
        sql: "INSERT INTO accounts (id, name, type) VALUES ('acct1', 'Chase Sapphire', 'credit')",
      });
      await csvTx({ name: 'AMAZON', amount: 50 });
      await plaidTx({ name: 'AMAZON', amount: 50 });
      const pairs = await getCsvPlaidDupeCandidates();
      expect(pairs).toHaveLength(1);
      expect(pairs[0].accountName).toBe('Chase Sapphire');
    });

    // The account row can go missing — deleteAccount cascades to transactions,
    // but a half-finished delete or a restored backup can leave orphans behind.
    // Those still deduplicate; they just have no name to show.
    it('still reports rows whose account is missing', async () => {
      await csvTx({ name: 'AMAZON', amount: 50 });
      await plaidTx({ name: 'AMAZON', amount: 50 });
      const pairs = await getCsvPlaidDupeCandidates();
      expect(pairs).toHaveLength(1);
      expect(pairs[0].accountName).toBe('');
    });

    it('lists newest first', async () => {
      const older = await csvTx({ name: 'AMAZON', amount: 50, date: '2025-01-10' });
      const newer = await csvTx({ name: 'NETFLIX', amount: 15, date: '2025-02-10' });
      await plaidTx({ name: 'AMAZON', amount: 50, date: '2025-01-10' });
      await plaidTx({ name: 'NETFLIX', amount: 15, date: '2025-02-10' });
      const pairs = await getCsvPlaidDupeCandidates();
      expect(pairs.map((p) => p.csvId)).toEqual([newer, older]);
    });
  });

  it('returns count of removed transactions', async () => {
    await csvTx({ name: 'AMAZON', amount: 10 });
    await csvTx({ name: 'NETFLIX', amount: 15 });
    await csvTx({ name: 'STARBUCKS', amount: 5 });
    await plaidTx({ name: 'AMAZON', amount: 10 });
    await plaidTx({ name: 'NETFLIX', amount: 15 });
    expect(await deduplicateCsvVsPlaid()).toBe(2);
  });
});
