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
  db.prepare("INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES (?, 'a', '2025-01-01', 'T', 10, 'S', 0, 0)").run(id);
  return id;
}

beforeEach(() => {
  txId = 0;
  db.exec('DELETE FROM transaction_tags');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM transactions');
});

// ──────────────────────────────────────────────────────────────────────
describe('createTag', () => {
  it('creates a new tag', () => {
    createTag('food');
    const rows = db.prepare('SELECT name FROM tags').all() as { name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('food');
  });

  it('is idempotent (INSERT OR IGNORE)', () => {
    createTag('food');
    createTag('food');
    const rows = db.prepare('SELECT name FROM tags').all();
    expect(rows).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('renameTag', () => {
  it('renames a tag by id', () => {
    createTag('food');
    const { id } = db.prepare('SELECT id FROM tags WHERE name = ?').get('food') as { id: number };
    renameTag(id, 'groceries');
    const { name } = db.prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string };
    expect(name).toBe('groceries');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('deleteTag', () => {
  it('removes the tag and all its transaction links', () => {
    createTag('food');
    const { id } = db.prepare('SELECT id FROM tags WHERE name = ?').get('food') as { id: number };
    const txId = insertTx();
    addTagToTransaction(txId, id);

    deleteTag(id);

    expect(db.prepare('SELECT * FROM tags WHERE id = ?').get(id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM transaction_tags WHERE tag_id = ?').get(id)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getOrCreateTag', () => {
  it('creates a tag and returns its id', () => {
    const id = getOrCreateTag('travel');
    expect(typeof id).toBe('number');
    const row = db.prepare('SELECT name FROM tags WHERE id = ?').get(id) as { name: string };
    expect(row.name).toBe('travel');
  });

  it('returns the existing id if tag already exists', () => {
    const id1 = getOrCreateTag('travel');
    const id2 = getOrCreateTag('travel');
    expect(id1).toBe(id2);
    expect((db.prepare('SELECT COUNT(*) as c FROM tags').get() as { c: number }).c).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTagOptions', () => {
  it('returns all tags sorted by name', () => {
    createTag('zzz');
    createTag('aaa');
    createTag('mmm');
    const opts = getTagOptions();
    expect(opts.map((t) => t.name)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('returns empty array when no tags', () => {
    expect(getTagOptions()).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('getTransactionTagIds', () => {
  it('returns the set of tag ids for a transaction', () => {
    const tx = insertTx();
    const id1 = getOrCreateTag('food');
    const id2 = getOrCreateTag('travel');
    addTagToTransaction(tx, id1);
    addTagToTransaction(tx, id2);
    const ids = getTransactionTagIds(tx);
    expect(ids.has(id1)).toBe(true);
    expect(ids.has(id2)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('returns empty set for untagged transaction', () => {
    const tx = insertTx();
    expect(getTransactionTagIds(tx).size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransaction / removeTagFromTransaction', () => {
  it('adds and removes a tag', () => {
    const tx = insertTx();
    const tagId = getOrCreateTag('food');

    addTagToTransaction(tx, tagId);
    expect(getTransactionTagIds(tx).has(tagId)).toBe(true);

    removeTagFromTransaction(tx, tagId);
    expect(getTransactionTagIds(tx).has(tagId)).toBe(false);
  });

  it('addTagToTransaction is idempotent', () => {
    const tx = insertTx();
    const tagId = getOrCreateTag('food');
    addTagToTransaction(tx, tagId);
    addTagToTransaction(tx, tagId);
    expect(getTransactionTagIds(tx).size).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('addTagToTransactions', () => {
  it('adds a tag to multiple transactions at once', () => {
    const tx1 = insertTx();
    const tx2 = insertTx();
    const tx3 = insertTx();
    const tagId = getOrCreateTag('bulk');

    addTagToTransactions([tx1, tx2], tagId);

    expect(getTransactionTagIds(tx1).has(tagId)).toBe(true);
    expect(getTransactionTagIds(tx2).has(tagId)).toBe(true);
    expect(getTransactionTagIds(tx3).has(tagId)).toBe(false);
  });
});
