import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { applyTagRules } from '../core/tag-rules.js';
import { deduplicateCsvVsPlaid, getCsvPlaidDupeCandidates } from '../core/dedup.js';
import { deleteDuplicate, deleteAllDuplicates } from '../core/accounts.js';
import { seedTx } from './helpers/seedDb.js';

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
async function manualTx(opts: { name: string; amount: number; date?: string; accountId?: string }) {
  seq++;
  const id = `manual-${seq}`;
  await db.execute({
    sql: "INSERT INTO transactions (id, account_id, date, name, amount, pending, ignored, source) VALUES (?, ?, ?, ?, ?, 0, 0, 'manual')",
    args: [id, opts.accountId ?? 'acct1', opts.date ?? '2025-01-15', opts.name, opts.amount],
  });
  return id;
}
async function exists(id: string) {
  return (await db.execute({ sql: 'SELECT 1 FROM transactions WHERE id = ?', args: [id] })).rows.length > 0;
}

beforeEach(async () => {
  seq = 0;
  await db.execute('DELETE FROM transaction_tags');
  await db.execute('DELETE FROM tag_rule_suppressions');
  await db.execute('DELETE FROM tags');
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

// A manual entry standing in for a transaction Plaid's sync had missed. Once
// Plaid catches up, the pair must surface for review — but deduplicateCsvVsPlaid
// (the silent auto-delete pass) must never touch it, since a manual row may
// carry a hand-picked category/tag the newly-synced Plaid row won't have.
describe('manual rows vs the two dedup paths', () => {
  it('getCsvPlaidDupeCandidates surfaces a manual/Plaid pair, tagged by source', async () => {
    const manual = await manualTx({ name: 'Bill Payment', amount: 2914 });
    await plaidTx({ name: 'Bill Payment', amount: 2914 });
    const pairs = await getCsvPlaidDupeCandidates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].csvId).toBe(manual);
    expect(pairs[0].csvSource).toBe('manual');
  });

  it('tags a plain CSV/Plaid pair as csvSource "csv"', async () => {
    await csvTx({ name: 'AMAZON', amount: 50 });
    await plaidTx({ name: 'AMAZON', amount: 50 });
    const pairs = await getCsvPlaidDupeCandidates();
    expect(pairs[0].csvSource).toBe('csv');
  });

  it('deduplicateCsvVsPlaid never deletes a manual row, even when it matches Plaid', async () => {
    const manual = await manualTx({ name: 'Bill Payment', amount: 2914 });
    await plaidTx({ name: 'Bill Payment', amount: 2914 });
    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect(await exists(manual)).toBe(true);
  });

  it('deduplicateCsvVsPlaid still removes CSV rows when a manual row is also present', async () => {
    const csv = await csvTx({ name: 'NETFLIX', amount: 15 });
    const manual = await manualTx({ name: 'Bill Payment', amount: 2914 });
    await plaidTx({ name: 'NETFLIX', amount: 15 });
    await plaidTx({ name: 'Bill Payment', amount: 2914 });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(csv)).toBe(false);
    expect(await exists(manual)).toBe(true);
  });
});

describe('deduplicateCsvVsPlaid with reattributed dates', () => {
  it('still matches a duplicate whose displayed date was moved months away', async () => {
    // Same transaction from both sources, posted a day apart. The CSV copy has
    // been reattributed to a prior period; matching must use the posting date.
    const csvId = await csvTx({ name: 'BRAINCO TECHNOLO', amount: -5531.2, date: '2025-01-01' });
    await db.execute({
      sql: "UPDATE transactions SET date = '2024-11-30', original_date = '2025-01-01' WHERE id = ?",
      args: [csvId],
    });
    await plaidTx({ name: 'BRAINCO TECHNOLO', amount: -5531.2, date: '2025-01-02' });

    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(csvId)).toBe(false);
  });

  it('does not match when the posting dates are genuinely far apart', async () => {
    // Reattributing must not manufacture a match either: these are two real,
    // distinct payments that happen to share an amount.
    const csvId = await csvTx({ name: 'Albany Children\'s Center', amount: 2914, date: '2024-11-25' });
    await db.execute({
      sql: "UPDATE transactions SET date = '2025-01-02', original_date = '2024-11-25' WHERE id = ?",
      args: [csvId],
    });
    await plaidTx({ name: 'Albany Children\'s Center', amount: 2914, date: '2025-01-02' });

    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect(await exists(csvId)).toBe(true);
  });
});

// ─── Edit transfer: a deduped CSV row's user edits move to the surviving Plaid row ───

describe('edit transfer on dedup', () => {
  const row = async (id: string) =>
    (await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as Record<string, string | number | null>;
  const tagNames = async (id: string) =>
    (await db.execute({ sql: 'SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY t.name', args: [id] }))
      .rows.map((r) => (r as unknown as { name: string }).name);
  async function tag(name: string, ...txIds: string[]) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO tags (name) VALUES (?)', args: [name] });
    const id = Number((await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] })).rows[0].id);
    for (const t of txIds) await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [t, id] });
  }
  const pair = async (csv: Parameters<typeof seedTx>[1] = {}, plaid: Parameters<typeof seedTx>[1] = {}) => ({
    csv: (await seedTx(db, { source: 'csv', name: 'LATTE', amount: 5, ...csv })).id,
    plaid: (await seedTx(db, { source: 'plaid', name: 'LATTE', amount: 5, ...plaid })).id,
  });

  it('transfers manual_category, display_name, ignored and tags to the Plaid row', async () => {
    const { csv, plaid } = await pair({ manual_category: 'Dining', category: 'Dining', display_name: 'My latte', ignored: true });
    await tag('coffee', csv);
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(csv)).toBe(false);
    expect(await row(plaid)).toMatchObject({ manual_category: 'Dining', category: 'Dining', display_name: 'My latte', ignored: 1 });
    expect(await tagNames(plaid)).toEqual(['coffee']);
  });

  it("the Plaid row's own edits win; tags are unioned without duplicates", async () => {
    const { csv, plaid } = await pair(
      { manual_category: 'Dining', display_name: 'My latte' },
      { manual_category: 'Coffee', category: 'Coffee', display_name: 'Latte!' },
    );
    await tag('shared', csv, plaid);
    await tag('csv-only', csv);
    await tag('plaid-only', plaid);
    await deduplicateCsvVsPlaid();
    expect(await row(plaid)).toMatchObject({ manual_category: 'Coffee', category: 'Coffee', display_name: 'Latte!', ignored: 0 });
    expect(await tagNames(plaid)).toEqual(['csv-only', 'plaid-only', 'shared']);
  });

  it('an ignored Plaid row stays ignored when the CSV row was not', async () => {
    const { plaid } = await pair({}, { ignored: true });
    await deduplicateCsvVsPlaid();
    expect((await row(plaid)).ignored).toBe(1);
  });

  it('a CSV row with no edits leaves the Plaid row untouched', async () => {
    const { plaid } = await pair({}, { category: 'Food' });
    await deduplicateCsvVsPlaid();
    expect(await row(plaid)).toMatchObject({ manual_category: null, display_name: null, ignored: 0, category: 'Food' });
  });

  it('with two CSV rows competing for one Plaid row, the best-ranked pair is deleted and its edits transfer; the other keeps its own', async () => {
    const plaid = (await seedTx(db, { source: 'plaid', name: 'LATTE', amount: 5, date: '2025-01-15' })).id;
    const exact = (await seedTx(db, { source: 'csv', name: 'LATTE', amount: 5, date: '2025-01-15', manual_category: 'Dining' })).id;
    const loose = (await seedTx(db, { source: 'csv', name: 'LATTE SHOP', amount: 5, date: '2025-01-15', manual_category: 'Other' })).id;
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(exact)).toBe(false);
    expect(await exists(loose)).toBe(true);
    expect((await row(plaid)).manual_category).toBe('Dining');
    expect((await row(loose)).manual_category).toBe('Other');
  });

  it('never auto-deletes a manual row, so its edits stay put', async () => {
    const manual = (await seedTx(db, { source: 'manual', name: 'LATTE', amount: 5, manual_category: 'Dining' })).id;
    const plaid = (await seedTx(db, { source: 'plaid', name: 'LATTE', amount: 5 })).id;
    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect((await row(manual)).manual_category).toBe('Dining');
    expect((await row(plaid)).manual_category).toBeNull();
  });

  describe('tag rule suppressions', () => {
    const tagId = async (name: string) => {
      await db.execute({ sql: 'INSERT OR IGNORE INTO tags (name) VALUES (?)', args: [name] });
      return Number((await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] })).rows[0].id);
    };
    const suppress = (txId: string, tag: number) =>
      db.execute({ sql: 'INSERT OR IGNORE INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: [txId, tag] });
    const suppressed = async (txId: string) =>
      (await db.execute({ sql: 'SELECT tag_id FROM tag_rule_suppressions WHERE transaction_id = ? ORDER BY tag_id', args: [txId] }))
        .rows.map((r) => Number(r.tag_id));
    const rule = (tag: number) =>
      db.execute({ sql: "INSERT INTO tag_rules (match_type, pattern, tag_id) VALUES ('name', 'latte', ?)", args: [tag] });
    beforeEach(async () => { await db.execute('DELETE FROM tag_rules'); });

    it('moves the CSV row\'s suppression to the Plaid row and removes the CSV row\'s', async () => {
      const { csv, plaid } = await pair();
      const coffee = await tagId('coffee');
      await suppress(csv, coffee);
      await deduplicateCsvVsPlaid();
      expect(await suppressed(plaid)).toEqual([coffee]);
      expect(await suppressed(csv)).toEqual([]);
    });

    it('a later applyTagRules does not re-add the removed tag on the Plaid row', async () => {
      const { csv, plaid } = await pair();
      const coffee = await tagId('coffee');
      await rule(coffee);
      await suppress(csv, coffee);
      await deduplicateCsvVsPlaid();
      await applyTagRules();
      expect(await tagNames(plaid)).toEqual([]);
    });

    it('only the suppressed tag stays off; other rule tags still apply', async () => {
      const { csv, plaid } = await pair();
      const coffee = await tagId('coffee');
      const treat = await tagId('treat');
      await rule(coffee);
      await rule(treat);
      await suppress(csv, coffee);
      await deduplicateCsvVsPlaid();
      await applyTagRules();
      expect(await tagNames(plaid)).toEqual(['treat']);
    });

    it('does not touch suppressions of an unrelated pair or the Plaid row\'s own', async () => {
      const a = await pair();
      const b = await pair({ name: 'GROCER', amount: 40 }, { name: 'GROCER', amount: 40 });
      const t1 = await tagId('t1');
      const t2 = await tagId('t2');
      await suppress(a.csv, t1);
      await suppress(a.plaid, t2);
      await suppress(b.csv, t2);
      await deduplicateCsvVsPlaid();
      expect(await suppressed(a.plaid)).toEqual([t1, t2]);
      expect(await suppressed(b.plaid)).toEqual([t2]);
    });

    it('with no suppressions, nothing is written', async () => {
      const { plaid } = await pair();
      await deduplicateCsvVsPlaid();
      expect(await suppressed(plaid)).toEqual([]);
      expect((await db.execute('SELECT COUNT(*) AS n FROM tag_rule_suppressions')).rows[0].n).toBe(0);
    });

    it('is idempotent when the Plaid row already has the same suppression', async () => {
      const { csv, plaid } = await pair();
      const coffee = await tagId('coffee');
      await suppress(csv, coffee);
      await suppress(plaid, coffee);
      expect(await deduplicateCsvVsPlaid()).toBe(1);
      expect(await suppressed(plaid)).toEqual([coffee]);
    });

    it('deleteAllDuplicates transfers suppressions for every pair', async () => {
      const a = await pair({ source: 'manual' });
      const b = await pair({ source: 'manual', name: 'GROCER', amount: 40 }, { name: 'GROCER', amount: 40 });
      const t1 = await tagId('t1');
      const t2 = await tagId('t2');
      await suppress(a.csv, t1);
      await suppress(b.csv, t2);
      await deleteAllDuplicates([a.csv, b.csv]);
      expect(await suppressed(a.plaid)).toEqual([t1]);
      expect(await suppressed(b.plaid)).toEqual([t2]);
      expect(await suppressed(a.csv)).toEqual([]);
      expect(await suppressed(b.csv)).toEqual([]);
    });

    it('review-tab delete (deleteDuplicate) transfers suppressions too', async () => {
      const { csv, plaid } = await pair({ source: 'manual' });
      const coffee = await tagId('coffee');
      await suppress(csv, coffee);
      await deleteDuplicate(csv);
      expect(await suppressed(plaid)).toEqual([coffee]);
    });
  });

  describe('user-confirmed duplicate deletes (review tab)', () => {
    it('deleteDuplicate transfers a manual row\'s edits to its Plaid twin', async () => {
      const { csv, plaid } = await pair({ source: 'manual', manual_category: 'Dining', display_name: 'My latte' });
      await tag('coffee', csv);
      await deleteDuplicate(csv);
      expect(await exists(csv)).toBe(false);
      expect(await row(plaid)).toMatchObject({ manual_category: 'Dining', display_name: 'My latte' });
      expect(await tagNames(plaid)).toEqual(['coffee']);
    });

    it.each([['a', 'b'], ['b', 'a']])('deleting only pair %s leaves pair %s untouched and transfers just that pair\'s edits', async (del, keep) => {
      const mk = async (n: string) => {
        const c = (await seedTx(db, { source: 'csv', name: `SHOP ${n}`, amount: n === 'a' ? 11 : 22, manual_category: `Cat-${n}` })).id;
        const p = (await seedTx(db, { source: 'plaid', name: `SHOP ${n}`, amount: n === 'a' ? 11 : 22 })).id;
        return { c, p };
      };
      const pairs = { a: await mk('a'), b: await mk('b') } as Record<string, { c: string; p: string }>;
      await deleteAllDuplicates([pairs[del].c]);
      expect(await exists(pairs[del].c)).toBe(false);
      expect((await row(pairs[del].p)).manual_category).toBe(`Cat-${del}`);
      expect(await exists(pairs[keep].c)).toBe(true);
      expect((await row(pairs[keep].p)).manual_category).toBeNull();

      // Same through the single-id path.
      await deleteDuplicate(pairs[keep].c);
      expect(await exists(pairs[keep].c)).toBe(false);
      expect((await row(pairs[keep].p)).manual_category).toBe(`Cat-${keep}`);
    });

    it('deleteAllDuplicates still deletes ids that have no Plaid twin', async () => {
      const lone = (await seedTx(db, { source: 'csv', name: 'LONELY', amount: 9 })).id;
      const { csv } = await pair();
      await deleteAllDuplicates([lone, csv]);
      expect(await exists(lone)).toBe(false);
      expect(await exists(csv)).toBe(false);
    });
  });
});

// ─── Characterisation ────────────────────────────────────────────────────────

describe('dedup characterisation', () => {
  const csv = (o: Parameters<typeof seedTx>[1] = {}) => seedTx(db, { source: 'csv', name: 'AMAZON', amount: 25, date: '2025-01-15', ...o });
  const plaid = (o: Parameters<typeof seedTx>[1] = {}) => seedTx(db, { source: 'plaid', name: 'AMAZON', amount: 25, date: '2025-01-15', ...o });

  it('opposite-sign amounts with the same magnitude do not dedupe', async () => {
    const c = await csv({ amount: 25 }); await plaid({ amount: -25 });
    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect(await exists(c.id)).toBe(true);
  });

  it('a second call removes nothing more', async () => {
    await csv(); await plaid();
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await deduplicateCsvVsPlaid()).toBe(0);
  });

  it('a pending Plaid row absorbs a CSV row (pending is not checked)', async () => {
    const c = await csv(); await plaid({ pending: true });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
  });

  it('an ignored Plaid row absorbs a CSV row (ignored is not checked)', async () => {
    const c = await csv(); await plaid({ ignored: true });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
  });

  it.each([
    ['csv 3 days earlier', '2025-01-12', '2025-01-15', true],
    ['csv 3 days later', '2025-01-18', '2025-01-15', true],
    ['csv 4 days earlier', '2025-01-11', '2025-01-15', false],
    ['csv 4 days later', '2025-01-19', '2025-01-15', false],
  ])('%s', async (_n, csvDate, plaidDate, dedupes) => {
    const c = await csv({ date: csvDate }); await plaid({ date: plaidDate });
    expect(await deduplicateCsvVsPlaid()).toBe(dedupes ? 1 : 0);
    expect(await exists(c.id)).toBe(!dedupes);
  });

  it('original_date takes precedence over date on the CSV side', async () => {
    const c = await csv({ date: '2025-06-01', original_date: '2025-01-14' }); await plaid();
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
  });

  it('original_date takes precedence over date on the Plaid side', async () => {
    const c = await csv(); await plaid({ date: '2025-06-01', original_date: '2025-01-16' });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
  });

  it('original_date can also keep a nearby displayed date from matching', async () => {
    const c = await csv({ date: '2025-01-15', original_date: '2024-12-01' }); await plaid();
    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect(await exists(c.id)).toBe(true);
  });

  it.each([
    ['csv AMAZON vs plaid AMAZON MKTP', 'AMAZON', 'AMAZON MKTP'],
    ['csv AMAZON MKTP vs plaid AMAZON', 'AMAZON MKTP', 'AMAZON'],
  ])('name containment is symmetric: %s', async (_n, csvName, plaidName) => {
    const c = await csv({ name: csvName }); await plaid({ name: plaidName });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
  });

  it('with two Plaid rows competing, the exact-name Plaid row pairs and the other survives', async () => {
    const c = await csv({ name: 'AMAZON' });
    const exact = await plaid({ name: 'AMAZON' });
    const loose = await plaid({ name: 'AMAZON MKTP' });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    expect(await exists(c.id)).toBe(false);
    expect(await exists(exact.id)).toBe(true);
    expect(await exists(loose.id)).toBe(true);
  });

  it.each([
    ['5 chars before the star matches', 'AMAZO*XYZ123', true],
    // The rule is INSTR(name, '*') >= 5, i.e. the star at position 5 = 4 chars before it.
    ['4 chars before the star matches (threshold is the star at position 5)', 'AMAZ*XYZ123', true],
    ['3 chars before the star does not', 'AMA*XYZ123', false],
  ])('masked Plaid prefix: %s', async (_n, plaidName, dedupes) => {
    // CSV name shares only the prefix with the Plaid name, so only the masked-prefix rule can match.
    const c = await csv({ name: 'AMAZO ORDER 99', amount: 25 });
    await plaid({ name: plaidName });
    expect(await deduplicateCsvVsPlaid()).toBe(dedupes ? 1 : 0);
    expect(await exists(c.id)).toBe(!dedupes);
  });

  it('two real $5 coffees against one Plaid row leave exactly one CSV row', async () => {
    const a = await csv({ name: 'COFFEE', amount: 5 }); const b = await csv({ name: 'COFFEE', amount: 5 });
    await plaid({ name: 'COFFEE', amount: 5 });
    expect(await deduplicateCsvVsPlaid()).toBe(1);
    const survivors = (await Promise.all([a, b].map((t) => exists(t.id)))).filter(Boolean);
    expect(survivors).toHaveLength(1);
  });

  it('amounts are compared exactly: 29.99 vs 29.990001 do not dedupe', async () => {
    const c = await csv({ amount: 29.99 }); await plaid({ amount: 29.990001 });
    expect(await deduplicateCsvVsPlaid()).toBe(0);
    expect(await exists(c.id)).toBe(true);
  });
});
