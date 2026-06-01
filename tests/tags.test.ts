import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  createTag, renameTag, deleteTag, getOrCreateTag, getTagOptions,
  getTransactionTagIds, addTagToTransaction, removeTagFromTransaction, addTagToTransactions,
} from '../core/tags.js';

let txId = 0;
async function insertTx() {
  txId++;
  const id = `tx${txId}`;
  await db.execute({
    sql: "INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES (?, 'a', '2025-01-01', 'T', 10, 'S', 0, 0)",
    args: [id],
  });
  return id;
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transaction_tags');
  await db.execute('DELETE FROM tags');
  await db.execute('DELETE FROM transactions');
});

// ──────────────────────────────────────────────────────────────────────
describe('createTag', () => {
  it('creates a new tag', async () => {
    await createTag('food');
    const rows = (await db.execute('SELECT name FROM tags')).rows as unknown as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('food');
  });

  it('is idempotent (INSERT OR IGNORE)', async () => {
    await createTag('food');
    await createTag('food');
    const rows = (await db.execute('SELECT name FROM tags')).rows;
    expect(rows).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('renameTag', () => {
  it('renames a tag by id', async () => {
    await createTag('food');
    const { id } = (await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: ['food'] })).rows[0] as unknown as { id: number };
    await renameTag(id, 'groceries');
    const { name } = (await db.execute({ sql: 'SELECT name FROM tags WHERE id = ?', args: [id] })).rows[0] as unknown as { name: string };
    expect(name).toBe('groceries');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('deleteTag', () => {
  it('removes the tag and all its transaction links', async () => {
    await createTag('food');
    const { id } = (await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: ['food'] })).rows[0] as unknown as { id: number };
    const txId = await insertTx();
    await addTagToTransaction(txId, id);

    await deleteTag(id);

    expect((await db.execute({ sql: 'SELECT * FROM tags WHERE id = ?', args: [id] })).rows[0]).toBeUndefined();
    expect((await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE tag_id = ?', args: [id] })).rows[0]).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getOrCreateTag', () => {
  it('creates a tag and returns its id', async () => {
    const id = await getOrCreateTag('travel');
    expect(typeof id).toBe('number');
    const row = (await db.execute({ sql: 'SELECT name FROM tags WHERE id = ?', args: [id] })).rows[0] as unknown as { name: string };
    expect(row.name).toBe('travel');
  });

  it('returns the existing id if tag already exists', async () => {
    const id1 = await getOrCreateTag('travel');
    const id2 = await getOrCreateTag('travel');
    expect(id1).toBe(id2);
    const { c } = (await db.execute('SELECT COUNT(*) as c FROM tags')).rows[0] as unknown as { c: number };
    expect(c).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTagOptions', () => {
  it('returns all tags sorted by name', async () => {
    await createTag('zzz');
    await createTag('aaa');
    await createTag('mmm');
    const opts = await getTagOptions();
    expect(opts.map((t) => t.name)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('returns empty array when no tags', async () => {
    expect(await getTagOptions()).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTransactionTagIds', () => {
  it('returns the set of tag ids for a transaction', async () => {
    const tx = await insertTx();
    const id1 = await getOrCreateTag('food');
    const id2 = await getOrCreateTag('travel');
    await addTagToTransaction(tx, id1);
    await addTagToTransaction(tx, id2);
    const ids = await getTransactionTagIds(tx);
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('returns empty set for untagged transaction', async () => {
    const tx = await insertTx();
    expect((await getTransactionTagIds(tx)).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransaction / removeTagFromTransaction', () => {
  it('adds and removes a tag', async () => {
    const tx = await insertTx();
    const tagId = await getOrCreateTag('food');

    await addTagToTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).has(tagId)).toBe(true);

    await removeTagFromTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).has(tagId)).toBe(false);
  });

  it('addTagToTransaction is idempotent', async () => {
    const tx = await insertTx();
    const tagId = await getOrCreateTag('food');
    await addTagToTransaction(tx, tagId);
    await addTagToTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).size).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransactions', () => {
  it('adds a tag to multiple transactions at once', async () => {
    const tx1 = await insertTx();
    const tx2 = await insertTx();
    const tx3 = await insertTx();
    const tagId = await getOrCreateTag('bulk');

    await addTagToTransactions([tx1, tx2], tagId);

    expect((await getTransactionTagIds(tx1)).has(tagId)).toBe(true);
    expect((await getTransactionTagIds(tx2)).has(tagId)).toBe(true);
    expect((await getTransactionTagIds(tx3)).has(tagId)).toBe(false);
  });
});
