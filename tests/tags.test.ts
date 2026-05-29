import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
});

import { db } from '../core/db.js';
import {
  createTag, renameTag, deleteTag, getOrCreateTag, getTagOptions,
  getTransactionTagIds, addTagToTransaction, removeTagFromTransaction, addTagToTransactions,
} from '../core/tags.js';

let txId = 0;
function insertTx() {
  txId++;
  const id = `tx${txId}`;
  (db as any).prepare("INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES (?, 'a', '2025-01-01', 'T', 10, 'S', 0, 0)").run(id);
  return id;
}

beforeEach(() => {
  txId = 0;
  (db as any).exec('DELETE FROM transaction_tags');
  (db as any).exec('DELETE FROM tags');
  (db as any).exec('DELETE FROM transactions');
});

// ──────────────────────────────────────────────────────────────────────
describe('createTag', () => {
  it('creates a new tag', async () => {
    await createTag('food');
    const rows = (db as any).prepare('SELECT name FROM tags').all() as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('food');
  });

  it('is idempotent (INSERT OR IGNORE)', async () => {
    await createTag('food');
    await createTag('food');
    const rows = (db as any).prepare('SELECT name FROM tags').all();
    expect(rows).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('renameTag', () => {
  it('renames a tag by id', async () => {
    await createTag('food');
    const { id } = (db as any).prepare('SELECT id FROM tags WHERE name = ?').get('food') as { id: number };
    await renameTag(id, 'groceries');
    const { name } = (db as any).prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string };
    expect(name).toBe('groceries');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('deleteTag', () => {
  it('removes the tag and all its transaction links', async () => {
    await createTag('food');
    const { id } = (db as any).prepare('SELECT id FROM tags WHERE name = ?').get('food') as { id: number };
    const txId = insertTx();
    await addTagToTransaction(txId, id);

    await deleteTag(id);

    expect((db as any).prepare('SELECT * FROM tags WHERE id = ?').get(id)).toBeUndefined();
    expect((db as any).prepare('SELECT * FROM transaction_tags WHERE tag_id = ?').get(id)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getOrCreateTag', () => {
  it('creates a tag and returns its id', async () => {
    const id = await getOrCreateTag('travel');
    expect(typeof id).toBe('number');
    const row = (db as any).prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('travel');
  });

  it('returns the existing id if tag already exists', async () => {
    const id1 = await getOrCreateTag('travel');
    const id2 = await getOrCreateTag('travel');
    expect(id1).toBe(id2);
    expect(((db as any).prepare('SELECT COUNT(*) as c FROM tags').get() as { c: number }).c).toBe(1);
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
    const tx = insertTx();
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
    const tx = insertTx();
    expect((await getTransactionTagIds(tx)).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransaction / removeTagFromTransaction', () => {
  it('adds and removes a tag', async () => {
    const tx = insertTx();
    const tagId = await getOrCreateTag('food');

    await addTagToTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).has(tagId)).toBe(true);

    await removeTagFromTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).has(tagId)).toBe(false);
  });

  it('addTagToTransaction is idempotent', async () => {
    const tx = insertTx();
    const tagId = await getOrCreateTag('food');
    await addTagToTransaction(tx, tagId);
    await addTagToTransaction(tx, tagId);
    expect((await getTransactionTagIds(tx)).size).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransactions', () => {
  it('adds a tag to multiple transactions at once', async () => {
    const tx1 = insertTx();
    const tx2 = insertTx();
    const tx3 = insertTx();
    const tagId = await getOrCreateTag('bulk');

    await addTagToTransactions([tx1, tx2], tagId);

    expect((await getTransactionTagIds(tx1)).has(tagId)).toBe(true);
    expect((await getTransactionTagIds(tx2)).has(tagId)).toBe(true);
    expect((await getTransactionTagIds(tx3)).has(tagId)).toBe(false);
  });
});
