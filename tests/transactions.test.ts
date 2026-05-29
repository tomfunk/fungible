import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  setTransactionCategory,
  clearTransactionOverride,
  setTransactionIgnored,
  setTransactionDisplayName,
  deleteTransaction,
  upsertCategoryRule,
  upsertNameRule,
  setTransactionCategoryBulk,
  clearOverridesBulk,
  setIgnoredBulk,
} from '../core/transactions.js';

let txId = 0;
async function insertTx(opts: { name?: string; category?: string; manual_category?: string; ignored?: number; amount?: number }) {
  txId++;
  const id = `tx${txId}`;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, ignored, pending)
          VALUES (?, 'acct1', '2025-01-15', ?, ?, ?, ?, ?, 0)`,
    args: [id, opts.name ?? 'Test', opts.amount ?? 10, opts.category ?? 'Shopping', opts.manual_category ?? null, opts.ignored ?? 0],
  });
  return id;
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM category_rules');
  await db.execute('DELETE FROM name_rules');
  await db.execute('DELETE FROM transaction_tags');
  await db.execute('DELETE FROM tags');
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionCategory', () => {
  it('sets category and pins it as manual_category', async () => {
    const id = await insertTx({ category: 'Shopping' });
    await setTransactionCategory(id, 'Dining');
    const row = (await db.execute({ sql: 'SELECT category, manual_category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string; manual_category: string };
    expect(row.category).toBe('Dining');
    expect(row.manual_category).toBe('Dining');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('clearTransactionOverride', () => {
  it('reverts to rule-based category and clears manual_category', async () => {
    await db.execute({ sql: "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Netflix', 'Entertainment')", args: [] });
    const id = await insertTx({ name: 'Netflix', category: 'Streaming', manual_category: 'Streaming' });
    await clearTransactionOverride(id);
    const row = (await db.execute({ sql: 'SELECT category, manual_category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string; manual_category: string | null };
    expect(row.category).toBe('Entertainment');
    expect(row.manual_category).toBeNull();
  });

  it('falls back to Uncategorized when no rule matches', async () => {
    const id = await insertTx({ name: 'Unknown Merchant', category: 'Misc', manual_category: 'Misc' });
    await clearTransactionOverride(id);
    const row = (await db.execute({ sql: 'SELECT category, manual_category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string; manual_category: string | null };
    expect(row.category).toBe('Uncategorized');
    expect(row.manual_category).toBeNull();
  });

  it('does nothing for a non-existent id', async () => {
    await expect(clearTransactionOverride('does-not-exist')).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionIgnored', () => {
  it('sets ignored to true', async () => {
    const id = await insertTx({ ignored: 0 });
    await setTransactionIgnored(id, true);
    const row = (await db.execute({ sql: 'SELECT ignored FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { ignored: number };
    expect(row.ignored).toBe(1);
  });

  it('sets ignored to false', async () => {
    const id = await insertTx({ ignored: 1 });
    await setTransactionIgnored(id, false);
    const row = (await db.execute({ sql: 'SELECT ignored FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { ignored: number };
    expect(row.ignored).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionDisplayName', () => {
  it('updates display_name', async () => {
    const id = await insertTx({ name: 'AMZN Marketplace' });
    await setTransactionDisplayName(id, 'Amazon');
    const row = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { display_name: string };
    expect(row.display_name).toBe('Amazon');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('deleteTransaction', () => {
  it('removes the transaction and its tag links', async () => {
    const id = await insertTx({});
    await db.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: ['food'] });
    const tag = (await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: ['food'] })).rows[0] as unknown as { id: number };
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [id, tag.id] });

    await deleteTransaction(id);

    expect((await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: [id] })).rows[0]).toBeUndefined();
    expect((await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE transaction_id = ?', args: [id] })).rows[0]).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('upsertCategoryRule', () => {
  it('inserts a new rule and re-categorizes matching transactions', async () => {
    const id = await insertTx({ name: 'Spotify', category: 'Uncategorized' });
    const count = await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    expect(count).toBeGreaterThanOrEqual(1);
    const row = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string };
    expect(row.category).toBe('Entertainment');
  });

  it('updates an existing rule for the same pattern', async () => {
    await db.execute({ sql: "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Spotify', 'Music')", args: [] });
    await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    const rules = (await db.execute({ sql: "SELECT * FROM category_rules WHERE pattern = 'Spotify'" })).rows as unknown as { category: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0].category).toBe('Entertainment');
  });

  it('does not overwrite manually pinned categories', async () => {
    const id = await insertTx({ name: 'Spotify', category: 'Music', manual_category: 'Music' });
    await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    const row = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { category: string };
    expect(row.category).toBe('Music');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('upsertNameRule', () => {
  it('inserts a new name rule and applies it', async () => {
    const id = await insertTx({ name: 'AMZN Mktp US' });
    await upsertNameRule('AMZN', 'name', 'Amazon');
    const row = (await db.execute({ sql: 'SELECT display_name FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { display_name: string };
    expect(row.display_name).toBe('Amazon');
  });

  it('updates an existing name rule for the same pattern', async () => {
    await db.execute({ sql: "INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'AMZN', 'Amazon Old')", args: [] });
    await upsertNameRule('AMZN', 'name', 'Amazon');
    const rules = (await db.execute({ sql: "SELECT * FROM name_rules WHERE pattern = 'AMZN'" })).rows as unknown as { replacement: string }[];
    expect(rules).toHaveLength(1);
    expect(rules[0].replacement).toBe('Amazon');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionCategoryBulk', () => {
  it('sets category and pins all specified transactions', async () => {
    const id1 = await insertTx({ category: 'Shopping' });
    const id2 = await insertTx({ category: 'Dining' });
    const id3 = await insertTx({ category: 'Shopping' });
    await setTransactionCategoryBulk([id1, id2], 'Entertainment');
    const rows = (await db.execute('SELECT id, category, manual_category FROM transactions')).rows as unknown as { id: string; category: string; manual_category: string | null }[];
    const map = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(map[id1].category).toBe('Entertainment');
    expect(map[id2].category).toBe('Entertainment');
    expect(map[id3].category).toBe('Shopping');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('clearOverridesBulk', () => {
  it('clears manual_category for pinned transactions only', async () => {
    await db.execute({ sql: "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Spotify', 'Entertainment')", args: [] });
    const pinned = await insertTx({ name: 'Spotify', category: 'Music', manual_category: 'Music' });
    const unpinned = await insertTx({ name: 'Other', category: 'Shopping' });
    await clearOverridesBulk([pinned, unpinned]);
    const p = (await db.execute({ sql: 'SELECT category, manual_category FROM transactions WHERE id = ?', args: [pinned] })).rows[0] as unknown as { category: string; manual_category: string | null };
    expect(p.category).toBe('Entertainment');
    expect(p.manual_category).toBeNull();
    const u = (await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [unpinned] })).rows[0] as unknown as { category: string };
    expect(u.category).toBe('Shopping');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setIgnoredBulk', () => {
  it('sets ignored for all specified transactions', async () => {
    const id1 = await insertTx({ ignored: 0 });
    const id2 = await insertTx({ ignored: 0 });
    const id3 = await insertTx({ ignored: 0 });
    await setIgnoredBulk([id1, id2], true);
    const rows = (await db.execute('SELECT id, ignored FROM transactions')).rows as unknown as { id: string; ignored: number }[];
    const map = Object.fromEntries(rows.map((r) => [r.id, r.ignored]));
    expect(map[id1]).toBe(1);
    expect(map[id2]).toBe(1);
    expect(map[id3]).toBe(0);
  });

  it('can un-ignore transactions', async () => {
    const id = await insertTx({ ignored: 1 });
    await setIgnoredBulk([id], false);
    const row = (await db.execute({ sql: 'SELECT ignored FROM transactions WHERE id = ?', args: [id] })).rows[0] as unknown as { ignored: number };
    expect(row.ignored).toBe(0);
  });
});
