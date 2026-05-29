import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
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
function insertTx(opts: { name?: string; category?: string; manual_category?: string; ignored?: number; amount?: number }) {
  txId++;
  const id = `tx${txId}`;
  (db as any).prepare(`
    INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category, ignored, pending)
    VALUES (?, 'acct1', '2025-01-15', ?, ?, ?, ?, ?, 0)
  `).run(id, opts.name ?? 'Test', opts.amount ?? 10, opts.category ?? 'Shopping', opts.manual_category ?? null, opts.ignored ?? 0);
  return id;
}

beforeEach(() => {
  txId = 0;
  (db as any).exec('DELETE FROM transactions');
  (db as any).exec('DELETE FROM category_rules');
  (db as any).exec('DELETE FROM name_rules');
  (db as any).exec('DELETE FROM transaction_tags');
  (db as any).exec('DELETE FROM tags');
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionCategory', () => {
  it('sets category and pins it as manual_category', async () => {
    const id = insertTx({ category: 'Shopping' });
    await setTransactionCategory(id, 'Dining');
    const row = (db as any).prepare('SELECT category, manual_category FROM transactions WHERE id = ?').get(id) as { category: string; manual_category: string };
    expect(row.category).toBe('Dining');
    expect(row.manual_category).toBe('Dining');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('clearTransactionOverride', () => {
  it('reverts to rule-based category and clears manual_category', async () => {
    (db as any).prepare("INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Netflix', 'Entertainment')").run();
    const id = insertTx({ name: 'Netflix', category: 'Streaming', manual_category: 'Streaming' });
    await clearTransactionOverride(id);
    const row = (db as any).prepare('SELECT category, manual_category FROM transactions WHERE id = ?').get(id) as { category: string; manual_category: string | null };
    expect(row.category).toBe('Entertainment');
    expect(row.manual_category).toBeNull();
  });

  it('falls back to Uncategorized when no rule matches', async () => {
    const id = insertTx({ name: 'Unknown Merchant', category: 'Misc', manual_category: 'Misc' });
    await clearTransactionOverride(id);
    const row = (db as any).prepare('SELECT category, manual_category FROM transactions WHERE id = ?').get(id) as { category: string; manual_category: string | null };
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
    const id = insertTx({ ignored: 0 });
    await setTransactionIgnored(id, true);
    const row = (db as any).prepare('SELECT ignored FROM transactions WHERE id = ?').get(id) as { ignored: number };
    expect(row.ignored).toBe(1);
  });

  it('sets ignored to false', async () => {
    const id = insertTx({ ignored: 1 });
    await setTransactionIgnored(id, false);
    const row = (db as any).prepare('SELECT ignored FROM transactions WHERE id = ?').get(id) as { ignored: number };
    expect(row.ignored).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionDisplayName', () => {
  it('updates display_name', async () => {
    const id = insertTx({ name: 'AMZN Marketplace' });
    await setTransactionDisplayName(id, 'Amazon');
    const row = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get(id) as { display_name: string };
    expect(row.display_name).toBe('Amazon');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('deleteTransaction', () => {
  it('removes the transaction and its tag links', async () => {
    const id = insertTx({});
    (db as any).prepare('INSERT INTO tags (name) VALUES (?)').run('food');
    const tag = (db as any).prepare('SELECT id FROM tags WHERE name = ?').get('food') as { id: number };
    (db as any).prepare('INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)').run(id, tag.id);

    await deleteTransaction(id);

    const tx = (db as any).prepare('SELECT id FROM transactions WHERE id = ?').get(id);
    expect(tx).toBeUndefined();
    const link = (db as any).prepare('SELECT * FROM transaction_tags WHERE transaction_id = ?').get(id);
    expect(link).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('upsertCategoryRule', () => {
  it('inserts a new rule and re-categorizes matching transactions', async () => {
    const id = insertTx({ name: 'Spotify', category: 'Uncategorized' });
    const count = await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    expect(count).toBeGreaterThanOrEqual(1);
    const row = (db as any).prepare('SELECT category FROM transactions WHERE id = ?').get(id) as { category: string };
    expect(row.category).toBe('Entertainment');
  });

  it('updates an existing rule for the same pattern', async () => {
    (db as any).prepare("INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Spotify', 'Music')").run();
    await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    const rules = (db as any).prepare("SELECT * FROM category_rules WHERE pattern = 'Spotify'").all();
    expect(rules).toHaveLength(1);
    expect((rules[0] as { category: string }).category).toBe('Entertainment');
  });

  it('does not overwrite manually pinned categories', async () => {
    const id = insertTx({ name: 'Spotify', category: 'Music', manual_category: 'Music' });
    await upsertCategoryRule('Spotify', 'name', 'Entertainment');
    const row = (db as any).prepare('SELECT category FROM transactions WHERE id = ?').get(id) as { category: string };
    expect(row.category).toBe('Music');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('upsertNameRule', () => {
  it('inserts a new name rule and applies it', async () => {
    const id = insertTx({ name: 'AMZN Mktp US' });
    await upsertNameRule('AMZN', 'name', 'Amazon');
    const row = (db as any).prepare('SELECT display_name FROM transactions WHERE id = ?').get(id) as { display_name: string };
    expect(row.display_name).toBe('Amazon');
  });

  it('updates an existing name rule for the same pattern', async () => {
    (db as any).prepare("INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'AMZN', 'Amazon Old')").run();
    await upsertNameRule('AMZN', 'name', 'Amazon');
    const rules = (db as any).prepare("SELECT * FROM name_rules WHERE pattern = 'AMZN'").all();
    expect(rules).toHaveLength(1);
    expect((rules[0] as { replacement: string }).replacement).toBe('Amazon');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setTransactionCategoryBulk', () => {
  it('sets category and pins all specified transactions', async () => {
    const id1 = insertTx({ category: 'Shopping' });
    const id2 = insertTx({ category: 'Dining' });
    const id3 = insertTx({ category: 'Shopping' });
    await setTransactionCategoryBulk([id1, id2], 'Entertainment');
    const rows = (db as any).prepare('SELECT id, category, manual_category FROM transactions').all() as { id: string; category: string; manual_category: string | null }[];
    const map = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(map[id1].category).toBe('Entertainment');
    expect(map[id2].category).toBe('Entertainment');
    expect(map[id3].category).toBe('Shopping');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('clearOverridesBulk', () => {
  it('clears manual_category for pinned transactions only', async () => {
    (db as any).prepare("INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Spotify', 'Entertainment')").run();
    const pinned = insertTx({ name: 'Spotify', category: 'Music', manual_category: 'Music' });
    const unpinned = insertTx({ name: 'Other', category: 'Shopping' });
    await clearOverridesBulk([pinned, unpinned]);
    const p = (db as any).prepare('SELECT category, manual_category FROM transactions WHERE id = ?').get(pinned) as { category: string; manual_category: string | null };
    expect(p.category).toBe('Entertainment');
    expect(p.manual_category).toBeNull();
    const u = (db as any).prepare('SELECT category FROM transactions WHERE id = ?').get(unpinned) as { category: string };
    expect(u.category).toBe('Shopping');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('setIgnoredBulk', () => {
  it('sets ignored for all specified transactions', async () => {
    const id1 = insertTx({ ignored: 0 });
    const id2 = insertTx({ ignored: 0 });
    const id3 = insertTx({ ignored: 0 });
    await setIgnoredBulk([id1, id2], true);
    const rows = (db as any).prepare('SELECT id, ignored FROM transactions').all() as { id: string; ignored: number }[];
    const map = Object.fromEntries(rows.map((r) => [r.id, r.ignored]));
    expect(map[id1]).toBe(1);
    expect(map[id2]).toBe(1);
    expect(map[id3]).toBe(0);
  });

  it('can un-ignore transactions', async () => {
    const id = insertTx({ ignored: 1 });
    await setIgnoredBulk([id], false);
    const row = (db as any).prepare('SELECT ignored FROM transactions WHERE id = ?').get(id) as { ignored: number };
    expect(row.ignored).toBe(0);
  });
});
