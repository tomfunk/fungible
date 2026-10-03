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
import { makeFakePlaid } from './helpers/makeFakeProvider.js';
import { makePlaidTx, makePlaidAccount } from './helpers/makePlaidTx.js';
import { seedPlaidItem, seedTx } from './helpers/seedDb.js';
import { useFixedClock } from './helpers/fakeClock.js';
import { syncTransactions, syncAll, deleteSyncCursor, describeSyncProgress, type SyncProgress } from '../core/sync.js';

type PlaidStub = ReturnType<typeof makeFakePlaid>;

function installPlaid(plaid: PlaidStub): PlaidStub {
  vi.mocked(getPlaidClient).mockReturnValue(plaid as never);
  return plaid;
}

/** Single-response Plaid stub. Returns it so a test can assert which calls were made. */
const mockPlaid = (removed: string[] = [], added: object[] = []): PlaidStub =>
  installPlaid(makeFakePlaid({ pages: [{ removed, added, next_cursor: 'cursor-1' }] }));

/** Multi-response stub: one entry per page, has_more flipping false on the last. */
const mockPlaidPages = (pages: object[][]): PlaidStub =>
  installPlaid(makeFakePlaid({ pages: pages.map((added) => ({ added })) }));

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'name_rules', 'category_rules', 'tags', 'transactions', 'accounts', 'sync_state', 'balance_history', 'plaid_items']) {
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


// ─── Re-sync semantics ───────────────────────────────────────────────────────

const q = async <T = Record<string, unknown>>(sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows as unknown as T[];
const txById = async (id: string) =>
  (await q<Record<string, string | number | null>>('SELECT * FROM transactions WHERE id = ?', [id]))[0];
const cursorOf = async (itemId: string) =>
  (await q<{ cursor: string }>('SELECT cursor FROM sync_state WHERE account_id = ?', [itemId]))[0]?.cursor;

describe('re-sync preserves user edits', () => {
  it('keeps manual_category and ignored when Plaid re-sends the row', async () => {
    await seedTx(db, { id: 'p1', category: 'Travel', manual_category: 'Travel', ignored: true });
    mockPlaid([], [makePlaidTx({ transaction_id: 'p1', primaryCategory: 'FOOD_AND_DRINK' })]);
    await syncTransactions('tok', 'item-1');
    const row = await txById('p1');
    expect(row.category).toBe('Travel');
    expect(row.manual_category).toBe('Travel');
    expect(row.ignored).toBe(1);
    expect(row.raw_category).toBe('FOOD_AND_DRINK');
  });

  it('keeps manual_category on a modified row too', async () => {
    await seedTx(db, { id: 'p1', manual_category: 'Gifts', category: 'Gifts' });
    plaid_modified([makePlaidTx({ transaction_id: 'p1', amount: 99, primaryCategory: 'TRAVEL' })]);
    await syncTransactions('tok', 'item-1');
    expect(await txById('p1')).toMatchObject({ category: 'Gifts', amount: 99 });
  });

  it('modified pending -> posted flips pending to 0 and updates the amount', async () => {
    mockPlaid([], [makePlaidTx({ transaction_id: 'p1', pending: true, amount: 10 })]);
    await syncTransactions('tok', 'item-1');
    expect((await txById('p1')).pending).toBe(1);

    plaid_modified([makePlaidTx({ transaction_id: 'p1', pending: false, amount: 12.34 })]);
    await syncTransactions('tok', 'item-1');
    expect(await txById('p1')).toMatchObject({ pending: 0, amount: 12.34 });
  });

  it('keeps the reattributed date on a modified row when original_date is set', async () => {
    await seedTx(db, { id: 'p1', date: '2025-06-30', original_date: '2025-07-01' });
    plaid_modified([makePlaidTx({ transaction_id: 'p1', date: '2025-07-02', amount: 7 })]);
    await syncTransactions('tok', 'item-1');
    expect(await txById('p1')).toMatchObject({ date: '2025-06-30', original_date: '2025-07-01', amount: 7 });
  });
});

function plaid_modified(modified: object[]): PlaidStub {
  return installPlaid(makeFakePlaid({ pages: [{ modified }] }));
}

describe('rules apply on add and on modify', () => {
  async function seedRules() {
    await db.execute("INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'starbucks', 'Coffee Shop')");
    await db.execute("INSERT INTO tags (name) VALUES ('caffeine')");
    const tagId = Number((await q<{ id: number }>("SELECT id FROM tags WHERE name = 'caffeine'"))[0].id);
    await db.execute({ sql: "INSERT INTO tag_rules (priority, match_type, pattern, tag_id) VALUES (0, 'name', 'starbucks', ?)", args: [tagId] });
    return tagId;
  }
  const tagsOf = async (id: string) =>
    (await q<{ name: string }>('SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.transaction_id = ?', [id])).map((r) => r.name);

  it('renames and tags a newly added transaction', async () => {
    await seedRules();
    mockPlaid([], [makePlaidTx({ transaction_id: 'n1', name: 'STARBUCKS #12' })]);
    await syncTransactions('tok', 'item-1');
    expect((await txById('n1')).display_name).toBe('Coffee Shop');
    expect(await tagsOf('n1')).toEqual(['caffeine']);
  });

  it('applies name and tag rules when a transaction is modified into a match', async () => {
    mockPlaid([], [makePlaidTx({ transaction_id: 'm1', name: 'PENDING CHARGE' })]);
    await syncTransactions('tok', 'item-1');
    expect((await txById('m1')).display_name).toBeNull();
    expect(await tagsOf('m1')).toEqual([]);

    await seedRules();
    plaid_modified([makePlaidTx({ transaction_id: 'm1', name: 'STARBUCKS #12' })]);
    await syncTransactions('tok', 'item-1');
    expect((await txById('m1')).display_name).toBe('Coffee Shop');
    expect(await tagsOf('m1')).toEqual(['caffeine']);
  });
});

describe('cursor handling', () => {
  it('a multi-page sync stores the final cursor and every page of rows', async () => {
    installPlaid(makeFakePlaid({ pages: [
      { added: [makePlaidTx({ transaction_id: 'a' })], next_cursor: 'c1' },
      { added: [makePlaidTx({ transaction_id: 'b' })], next_cursor: 'c2' },
      { added: [makePlaidTx({ transaction_id: 'c' })], next_cursor: 'c3' },
    ] }));
    await syncTransactions('tok', 'item-1');
    expect(await cursorOf('item-1')).toBe('c3');
    expect((await q<{ id: string }>('SELECT id FROM transactions ORDER BY id')).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('page 2 failure leaves the cursor unchanged and writes nothing, and the next sync resumes from the old cursor', async () => {
    await seedPlaidItem(db, 'item-1');
    await db.execute("INSERT INTO sync_state (account_id, cursor) VALUES ('item-1', 'old')");
    installPlaid(makeFakePlaid({
      pages: [{ added: [makePlaidTx({ transaction_id: 'a' })], next_cursor: 'c1' }, new Error('plaid down')],
      accounts: [makePlaidAccount({ current: 50 })],
    }));
    await expect(syncTransactions('tok', 'item-1')).rejects.toThrow('plaid down');
    expect(await cursorOf('item-1')).toBe('old');
    expect(await q('SELECT id FROM transactions')).toHaveLength(0);
    expect(await q('SELECT * FROM balance_history')).toHaveLength(0);

    const retry = installPlaid(makeFakePlaid({ pages: [{ added: [makePlaidTx({ transaction_id: 'a' })], next_cursor: 'c9' }] }));
    await syncTransactions('tok', 'item-1');
    expect(retry.transactionsSync.mock.calls[0][0]?.cursor).toBe('old');
    expect(await cursorOf('item-1')).toBe('c9');
  });

  it('an accountsGet failure after the pages leaves cursor and rows untouched (so the feed is replayed)', async () => {
    await seedPlaidItem(db, 'item-1');
    await db.execute("INSERT INTO sync_state (account_id, cursor) VALUES ('item-1', 'old')");
    installPlaid(makeFakePlaid({
      pages: [{ added: [makePlaidTx({ transaction_id: 'a' })] }],
      accountsError: new Error('accounts down'),
    }));
    await expect(syncTransactions('tok', 'item-1')).rejects.toThrow('accounts down');
    expect(await cursorOf('item-1')).toBe('old');
    expect(await q('SELECT id FROM transactions')).toHaveLength(0);
    expect((await q<{ last_synced_at: number | null }>('SELECT last_synced_at FROM plaid_items'))[0].last_synced_at).toBeNull();
  });
});

describe('balance snapshots', () => {
  it('writes no balance_history row when current is null or undefined', async () => {
    installPlaid(makeFakePlaid({ accounts: [
      makePlaidAccount({ account_id: 'a-null', current: null }),
      makePlaidAccount({ account_id: 'a-undef', current: undefined }),
      makePlaidAccount({ account_id: 'a-ok', current: 5 }),
    ] }));
    await syncTransactions('tok', 'item-1');
    expect((await q<{ account_id: string }>('SELECT account_id FROM balance_history')).map((r) => r.account_id)).toEqual(['a-ok']);
    expect(await q('SELECT id FROM accounts')).toHaveLength(3);
  });

  describe('same day', () => {
    useFixedClock('2026-10-02T12:00:00Z');
    it('two syncs on one day with different balances leave one row holding the last value', async () => {
      installPlaid(makeFakePlaid({ accountsPerSync: [[makePlaidAccount({ current: 100 })], [makePlaidAccount({ current: 250 })]] }));
      await syncTransactions('tok', 'item-1');
      await syncTransactions('tok', 'item-1');
      expect(await q('SELECT balance, date FROM balance_history')).toEqual([{ balance: 250, date: '2026-10-02' }]);
    });
  });

  describe('late evening UTC', () => {
    useFixedClock('2026-10-02T23:30:00Z');
    it('dates the snapshot by the UTC calendar day, not the local one', async () => {
      const prev = process.env.TZ;
      process.env.TZ = 'Pacific/Auckland'; // local date is already Oct 3
      try {
        installPlaid(makeFakePlaid({ accounts: [makePlaidAccount({ current: 1 })] }));
        await syncTransactions('tok', 'item-1');
      } finally {
        if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
      }
      expect((await q<{ date: string }>('SELECT date FROM balance_history'))[0].date).toBe('2026-10-02');
    });
  });
});

describe('account upsert on re-sync', () => {
  it('renames and relinks an existing account to the synced item but keeps the user nickname', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, nickname, item_id) VALUES ('acct-1', 'Old Name', 'depository', 'My Checking', 'old-item')");
    installPlaid(makeFakePlaid({ accounts: [makePlaidAccount({ account_id: 'acct-1', name: 'New Name' })] }));
    await syncTransactions('tok', 'new-item');
    expect(await q('SELECT name, item_id, nickname FROM accounts WHERE id = ?', ['acct-1']))
      .toEqual([{ name: 'New Name', item_id: 'new-item', nickname: 'My Checking' }]);
  });
});

describe('dupes flow out', () => {
  async function seedCsvTwin() {
    await seedTx(db, { id: 'csv-1-0', source: 'csv', account_id: 'acct-1', date: '2025-01-01', name: 'COFFEE', amount: 4.5 });
  }
  const plaidCoffee = () => makePlaidTx({ transaction_id: 'pl-1', account_id: 'acct-1', date: '2025-01-01', name: 'COFFEE', amount: 4.5 });

  it('syncTransactions reports the CSV rows it removed as dupes', async () => {
    await seedCsvTwin();
    installPlaid(makeFakePlaid({ pages: [{ added: [plaidCoffee()] }], accounts: [makePlaidAccount()] }));
    expect(await syncTransactions('tok', 'item-1')).toMatchObject({ added: 1, dupes: 1 });
    expect((await q<{ id: string }>('SELECT id FROM transactions')).map((r) => r.id)).toEqual(['pl-1']);
  });

  it('syncAll carries dupes into the per-item result', async () => {
    await seedPlaidItem(db, 'item-1');
    await seedCsvTwin();
    installPlaid(makeFakePlaid({ pages: [{ added: [plaidCoffee()] }], accounts: [makePlaidAccount()] }));
    const [r] = await syncAll(true);
    expect(r).toMatchObject({ itemId: 'item-1', added: 1, dupes: 1, skipped: false });
  });
});

describe('syncAll debounce and failure isolation', () => {
  const NOW = Date.parse('2026-10-02T12:00:00Z');
  const MIN = 60_000;
  useFixedClock('2026-10-02T12:00:00Z');

  const run = async (agoMin: number, force = false) => {
    await seedPlaidItem(db, 'item-1', { lastSyncedAt: NOW - agoMin * MIN });
    const plaid = installPlaid(makeFakePlaid());
    const [r] = await syncAll(force);
    return { r, plaid };
  };

  it('skips an item synced 14 minutes ago and contacts nobody', async () => {
    const { r, plaid } = await run(14);
    expect(r).toMatchObject({ itemId: 'item-1', skipped: true, added: 0 });
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
  });

  it('syncs an item last synced 16 minutes ago and stamps last_synced_at', async () => {
    const { r } = await run(16);
    expect(r.skipped).toBe(false);
    expect((await q<{ last_synced_at: number }>('SELECT last_synced_at FROM plaid_items'))[0].last_synced_at).toBe(NOW);
  });

  it('exactly 15 minutes ago is no longer debounced (boundary is exclusive)', async () => {
    expect((await run(15)).r.skipped).toBe(false);
  });

  it('force overrides the debounce', async () => {
    const { r, plaid } = await run(1, true);
    expect(r.skipped).toBe(false);
    expect(plaid.transactionsSync).toHaveBeenCalled();
  });

  it('an item that has never synced is not debounced', async () => {
    await seedPlaidItem(db, 'item-1');
    installPlaid(makeFakePlaid());
    expect((await syncAll())[0].skipped).toBe(false);
  });

  it('one item throwing reports its error while the others still sync', async () => {
    await seedPlaidItem(db, 'item-bad', { accessToken: 'tok-bad' });
    await seedPlaidItem(db, 'item-ok', { accessToken: 'tok-ok' });
    const plaid = makeFakePlaid({ pages: [{ added: [makePlaidTx({ transaction_id: 'ok-tx' })] }] });
    const real = plaid.transactionsSync.getMockImplementation()!;
    plaid.transactionsSync.mockImplementation(async (req) => {
      if (req?.access_token === 'tok-bad') throw new Error('ITEM_LOGIN_REQUIRED');
      return real(req);
    });
    installPlaid(plaid);

    const results = await syncAll(true);
    const bad = results.find((r) => r.itemId === 'item-bad')!;
    const ok = results.find((r) => r.itemId === 'item-ok')!;
    expect(bad.error).toBe('ITEM_LOGIN_REQUIRED');
    expect(bad).toMatchObject({ added: 0, skipped: false });
    expect(ok.error).toBeUndefined();
    expect(ok.added).toBe(1);
    expect(await cursorOf('item-bad')).toBeUndefined();
    expect(await cursorOf('item-ok')).toBe('cursor-1');
  });
});
