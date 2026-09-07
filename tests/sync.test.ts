import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../core/plaid.js', () => ({
  getPlaidClient: vi.fn(),
  plaidErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { db } from '../core/db.js';
import { getPlaidClient } from '../core/plaid.js';
import { syncTransactions, syncAll, deleteSyncCursor, describeSyncProgress, type SyncProgress } from '../core/sync.js';

type PlaidStub = { transactionsSync: ReturnType<typeof vi.fn>; accountsGet: ReturnType<typeof vi.fn> };

function installPlaid(transactionsSync: ReturnType<typeof vi.fn>): PlaidStub {
  const client: PlaidStub = {
    transactionsSync,
    accountsGet: vi.fn().mockResolvedValue({ data: { accounts: [] } }),
  };
  vi.mocked(getPlaidClient).mockReturnValue(client as never);
  return client;
}

/** Single-response Plaid stub. Returns it so a test can assert which calls were made. */
const mockPlaid = (removed: string[] = [], added: object[] = []): PlaidStub =>
  installPlaid(vi.fn().mockResolvedValue({
    data: {
      added,
      modified: [],
      removed: removed.map((id) => ({ transaction_id: id })),
      has_more: false,
      next_cursor: 'cursor-1',
    },
  }));

/** Multi-response stub: one entry per page, has_more flipping false on the last. */
function mockPlaidPages(pages: object[][]): PlaidStub {
  let call = 0;
  return installPlaid(vi.fn().mockImplementation(() => {
    const added = pages[call++];
    return Promise.resolve({
      data: { added, modified: [], removed: [], has_more: call < pages.length, next_cursor: `cursor-${call}` },
    });
  }));
}

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions', 'accounts', 'sync_state', 'balance_history', 'plaid_items']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

async function insertTx(id: string) {
  await db.execute({ sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES (?, 'acct-1', '2025-01-01', 'Test', 10, 'Food', 0, 0)`, args: [id] });
}

async function insertTag(name: string): Promise<number> {
  await db.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: [name] });
  const r = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] });
  return Number((r.rows[0] as unknown as { id: number }).id);
}

describe('syncTransactions — removing tagged transactions', () => {
  it('deletes transaction_tags before the transaction to avoid FK constraint failure', async () => {
    await insertTx('tx-1');
    const tagId = await insertTag('groceries');
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-1', tagId] });

    mockPlaid(['tx-1']);
    await expect(syncTransactions('token', 'item-1')).resolves.not.toThrow();

    const tags = await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE transaction_id = ?', args: ['tx-1'] });
    const txs = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: ['tx-1'] });
    expect(tags.rows).toHaveLength(0);
    expect(txs.rows).toHaveLength(0);
  });

  it('also clears tag_rule_suppressions for removed transactions', async () => {
    await insertTx('tx-2');
    const tagId = await insertTag('travel');
    await db.execute({ sql: 'INSERT INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-2', tagId] });

    mockPlaid(['tx-2']);
    await syncTransactions('token', 'item-1');

    const rows = await db.execute({ sql: 'SELECT * FROM tag_rule_suppressions WHERE transaction_id = ?', args: ['tx-2'] });
    expect(rows.rows).toHaveLength(0);
  });

  it('leaves unrelated transactions and tags intact', async () => {
    await insertTx('tx-keep');
    await insertTx('tx-remove');
    const tagId = await insertTag('dining');
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-keep', tagId] });
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-remove', tagId] });

    mockPlaid(['tx-remove']);
    await syncTransactions('token', 'item-1');

    const kept = await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE transaction_id = ?', args: ['tx-keep'] });
    expect(kept.rows).toHaveLength(1);
  });
});

describe('syncAll item filter', () => {
  // access_token is stored plaintext here: decryptToken passes through any value
  // that isn't an iv:authTag:ciphertext triple, so no key file is needed.
  async function seedItems(...itemIds: string[]) {
    await db.batch(
      itemIds.map((id) => ({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
        args: [id, `tok-${id}`, id],
      })),
      'write',
    );
  }

  const syncedItemIds = async () => {
    const res = await db.execute('SELECT item_id FROM plaid_items WHERE last_synced_at IS NOT NULL ORDER BY item_id');
    return (res.rows as unknown as { item_id: string }[]).map((r) => r.item_id);
  };

  const cursorItemIds = async () => {
    const res = await db.execute('SELECT account_id FROM sync_state ORDER BY account_id');
    return (res.rows as unknown as { account_id: string }[]).map((r) => r.account_id);
  };

  it('syncs only the requested item', async () => {
    await seedItems('item-a', 'item-b');
    const plaid = mockPlaid();

    const results = await syncAll(true, ['item-a']);

    expect(results.map((r) => r.itemId)).toEqual(['item-a']);
    expect(await syncedItemIds()).toEqual(['item-a']);
    expect(await cursorItemIds()).toEqual(['item-a']);
    // One item, one Plaid round trip — item-b was never contacted.
    expect(plaid.transactionsSync).toHaveBeenCalledTimes(1);
    expect(plaid.transactionsSync).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'tok-item-a' }),
    );
  });

  it('syncs every item when no filter is given', async () => {
    await seedItems('item-a', 'item-b');
    mockPlaid();

    const results = await syncAll(true);

    expect(results.map((r) => r.itemId).sort()).toEqual(['item-a', 'item-b']);
    expect(await syncedItemIds()).toEqual(['item-a', 'item-b']);
  });

  // An empty scope means "sync these zero items", not "sync everything". The
  // array crosses the GUI's IPC bridge from the renderer, so a caller that
  // computes an empty list must not get a full sync of every institution — the
  // opposite of what it asked for, and expensive on a large database. `undefined`
  // remains the way to ask for all of them.
  it('treats an empty filter as an empty scope, not as unfiltered', async () => {
    await seedItems('item-a', 'item-b');
    const plaid = mockPlaid();

    const results = await syncAll(true, []);

    expect(results).toEqual([]);
    expect(await syncedItemIds()).toEqual([]);
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
  });

  it('syncs several named items and skips the rest', async () => {
    await seedItems('item-a', 'item-b', 'item-c');
    mockPlaid();

    await syncAll(true, ['item-a', 'item-c']);

    expect(await syncedItemIds()).toEqual(['item-a', 'item-c']);
  });

  it('returns no results for an item id that does not exist', async () => {
    await seedItems('item-a');
    mockPlaid();

    expect(await syncAll(true, ['item-nope'])).toEqual([]);
    expect(await syncedItemIds()).toEqual([]);
  });
});

describe('sync progress reporting', () => {
  async function seedItem(id: string) {
    await db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
      args: [id, `tok-${id}`, id],
    });
  }

  it('reports each phase, tagged with the item it belongs to', async () => {
    await seedItem('item-a');
    mockPlaid();

    const seen: [string, SyncProgress][] = [];
    await syncAll(true, ['item-a'], (itemId, p) => seen.push([itemId, p]));

    expect(seen.every(([id]) => id === 'item-a')).toBe(true);
    // Nothing to categorise or remove in an empty sync, so those phases are absent.
    expect(seen.map(([, p]) => p.phase)).toEqual(['transactions', 'accounts', 'dedup']);
  });

  it('reports the transactions phase before the first request, so page 1 is not silent', async () => {
    await seedItem('item-a');
    mockPlaid();

    const seen: SyncProgress[] = [];
    await syncTransactions('tok', 'item-a', (p) => seen.push(p));

    expect(seen[0]).toEqual({ phase: 'transactions', page: 1, fetched: 0 });
  });

  it('emits one transactions step per page and carries the running count', async () => {
    await seedItem('item-a');
    const tx = (id: string) => ({
      transaction_id: id, account_id: 'acct1', date: '2025-01-01', name: 'X',
      amount: 1, pending: false, personal_finance_category: null, merchant_name: null,
    });
    mockPlaidPages([
      [tx('t1a'), tx('t1b')],
      [tx('t2a'), tx('t2b')],
    ]);

    const seen: SyncProgress[] = [];
    await syncTransactions('tok', 'item-a', (p) => seen.push(p));

    const pages = seen.filter((p) => p.phase === 'transactions');
    expect(pages).toEqual([
      { phase: 'transactions', page: 1, fetched: 0 },
      { phase: 'transactions', page: 2, fetched: 2 },
    ]);
    // The write phases show up once there is something to write.
    expect(seen.map((p) => p.phase)).toContain('categorize');
    expect(seen.map((p) => p.phase)).toContain('tag-rules');
  });

  it('stays optional — a sync with no callback still completes', async () => {
    await seedItem('item-a');
    mockPlaid();
    const results = await syncAll(true, ['item-a']);
    expect(results[0].error).toBeUndefined();
  });
});

describe('deleteSyncCursor', () => {
  async function seedItem(itemId: string, cursor?: string) {
    await db.execute({
      sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
      args: [itemId, `tok-${itemId}`, itemId],
    });
    if (cursor !== undefined) {
      await db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: [itemId, cursor] });
    }
  }

  it('drops the stored cursor', async () => {
    await seedItem('item-a', 'stale');
    await deleteSyncCursor('item-a');
    const rows = await db.execute({ sql: 'SELECT cursor FROM sync_state WHERE account_id = ?', args: ['item-a'] });
    expect(rows.rows).toHaveLength(0);
  });

  it('leaves other items\' cursors alone', async () => {
    await seedItem('item-a', 'stale');
    await seedItem('item-b', 'keep-me');
    await deleteSyncCursor('item-a');
    const rows = await db.execute({ sql: 'SELECT cursor FROM sync_state WHERE account_id = ?', args: ['item-b'] });
    expect((rows.rows[0] as unknown as { cursor: string }).cursor).toBe('keep-me');
  });

  it('is a no-op for an item that has never synced', async () => {
    await seedItem('item-a');
    await expect(deleteSyncCursor('item-a')).resolves.toBeUndefined();
  });

  // The point of the whole feature: the next sync must start from the beginning
  // of the change feed, not from where we left off.
  it('makes the following sync request history from the beginning', async () => {
    await seedItem('item-a', 'stale');
    const plaid = mockPlaid();

    await deleteSyncCursor('item-a');
    await syncAll(true, ['item-a']);

    expect(plaid.transactionsSync).toHaveBeenCalledTimes(1);
    expect(plaid.transactionsSync.mock.calls[0][0]).toMatchObject({ cursor: undefined });
  });

  it('without the delete, the same sync resumes from the stored cursor', async () => {
    await seedItem('item-a', 'stale');
    const plaid = mockPlaid();

    await syncAll(true, ['item-a']);

    expect(plaid.transactionsSync.mock.calls[0][0]).toMatchObject({ cursor: 'stale' });
  });

  it('restores a transaction the database had lost but Plaid still holds', async () => {
    await seedItem('item-a', 'stale');
    mockPlaid([], [{
      transaction_id: 'tx-9', account_id: 'acct-1', date: '2026-08-01', name: 'Coffee',
      merchant_name: null, amount: 4.5, pending: false,
      personal_finance_category: { primary: 'FOOD_AND_DRINK' },
    }]);

    await deleteSyncCursor('item-a');
    const [result] = await syncAll(true, ['item-a']);

    expect(result).toMatchObject({ itemId: 'item-a', added: 1 });
    const rows = await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: ['tx-9'] });
    expect(rows.rows).toHaveLength(1);
  });

  // The limit the confirmation copy promises. A row deleted *because* Plaid
  // reported it removed is absent from the replayed feed for the same reason it
  // was deleted, so cursor-zero cannot bring it back. Pinned because the copy
  // ("Transactions Plaid no longer has will not") depends on it.
  it('does not restore a transaction Plaid itself no longer has', async () => {
    await seedItem('item-a', 'stale');
    await insertTx('tx-gone');
    // First sync: Plaid reports it removed, so the row is deleted locally.
    mockPlaid(['tx-gone']);
    await syncAll(true, ['item-a']);
    const afterRemoval = await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: ['tx-gone'] });
    expect(afterRemoval.rows).toHaveLength(0);

    // Cursor-zero replay: Plaid's feed no longer contains it, so it stays gone.
    mockPlaid();
    await deleteSyncCursor('item-a');
    await syncAll(true, ['item-a']);

    const afterReplay = await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: ['tx-gone'] });
    expect(afterReplay.rows).toHaveLength(0);
  });
});

describe('describeSyncProgress', () => {
  it('renders each phase as user-facing text', () => {
    expect(describeSyncProgress({ phase: 'transactions', page: 1, fetched: 1234 }))
      .toBe('Fetching transactions… 1,234 so far');
    expect(describeSyncProgress({ phase: 'accounts' })).toBe('Fetching accounts & balances…');
    expect(describeSyncProgress({ phase: 'categorize', count: 1 })).toBe('Categorizing 1 transaction…');
    expect(describeSyncProgress({ phase: 'categorize', count: 2000 })).toBe('Categorizing 2,000 transactions…');
    expect(describeSyncProgress({ phase: 'tag-rules', count: 5 })).toBe('Applying tag rules…');
    expect(describeSyncProgress({ phase: 'remove', count: 1 })).toBe('Removing 1 deleted transaction…');
    expect(describeSyncProgress({ phase: 'dedup' })).toBe('Checking for duplicates…');
  });
});

describe('syncTransactions — reattributed dates survive re-sync', () => {
  const plaidTx = (id: string, date: string) => ({
    transaction_id: id,
    account_id: 'acct-1',
    date,
    name: 'BRAINCO TECHNOLO',
    merchant_name: null,
    amount: -5531.2,
    pending: false,
    personal_finance_category: { primary: 'INCOME' },
  });

  async function dateOf(id: string) {
    const r = await db.execute({ sql: 'SELECT date, original_date FROM transactions WHERE id = ?', args: [id] });
    return r.rows[0] as unknown as { date: string; original_date: string | null };
  }

  it('keeps a reattributed date when Plaid re-sends the transaction', async () => {
    mockPlaid([], [plaidTx('tx-pay', '2025-07-01')]);
    await syncTransactions('token', 'item-1');
    await db.execute("UPDATE transactions SET date = '2025-06-30', original_date = '2025-07-01' WHERE id = 'tx-pay'");

    // Plaid re-sends the same row on a later sync with its own posting date.
    await deleteSyncCursor('item-1');
    mockPlaid([], [plaidTx('tx-pay', '2025-07-01')]);
    await syncTransactions('token', 'item-1');

    expect(await dateOf('tx-pay')).toEqual({ date: '2025-06-30', original_date: '2025-07-01' });
  });

  it('still accepts Plaid date changes on transactions with no override', async () => {
    mockPlaid([], [plaidTx('tx-pay', '2025-07-01')]);
    await syncTransactions('token', 'item-1');

    await deleteSyncCursor('item-1');
    mockPlaid([], [plaidTx('tx-pay', '2025-07-03')]);
    await syncTransactions('token', 'item-1');

    expect(await dateOf('tx-pay')).toEqual({ date: '2025-07-03', original_date: null });
  });
});
