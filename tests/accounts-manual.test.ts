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
import { seedTx } from './helpers/seedDb.js';
import { useFixedClock } from './helpers/fakeClock.js';
import {
  createManualAccount, createCsvAccount, updateAccountValue, updateAccountApr,
} from '../core/accounts.js';
import { deleteTransaction, addTransaction } from '../core/transactions.js';
import { syncTransactions, deleteSyncCursor } from '../core/sync.js';
import { getLinkedAccounts } from '../core/queries.js';

useFixedClock(); // 2026-10-02T12:00:00Z

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'name_rules', 'category_rules', 'tags', 'transactions', 'accounts', 'sync_state', 'balance_history', 'plaid_items']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

const TODAY = '2026-10-02';
async function history(id: string) {
  const r = await db.execute({ sql: 'SELECT balance, date FROM balance_history WHERE account_id = ? ORDER BY date', args: [id] });
  return r.rows.map((x) => ({ balance: Number(x.balance), date: String(x.date) }));
}
async function accountRows() {
  return (await db.execute('SELECT * FROM accounts')).rows;
}

describe('createManualAccount', () => {
  it('trims the name, stores type other/subtype manual and one balance row for today', async () => {
    const id = await createManualAccount('  Home  ', 250000);
    expect(id.startsWith('manual-')).toBe(true);
    const [a] = (await db.execute({ sql: 'SELECT name, type, subtype FROM accounts WHERE id = ?', args: [id] })).rows;
    expect({ ...a }).toEqual({ name: 'Home', type: 'other', subtype: 'manual' });
    expect(await history(id)).toEqual([{ balance: 250000, date: TODAY }]);
  });

  // SUSPECTED BUG: id is `manual-${Date.now()}`, so two creations in the same
  // millisecond collide. Under a fixed clock this is deterministic. The second
  // INSERT INTO accounts hits the PRIMARY KEY and the whole batch throws (the
  // first account is NOT silently overwritten), so the second account is lost
  // with a UNIQUE constraint error. Pinned until ids get a random suffix.
  it.fails('two accounts created in the same millisecond get distinct ids', async () => {
    const a = await createManualAccount('Home', 1);
    const b = await createManualAccount('Car', 2);
    expect(b).not.toBe(a);
  });

  it('same-millisecond collision: second creation throws and leaves the first account untouched', async () => {
    const a = await createManualAccount('Home', 1);
    await expect(createManualAccount('Car', 2)).rejects.toThrow(/UNIQUE|constraint/i);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].name)).toBe('Home');
    expect(await history(a)).toEqual([{ balance: 1, date: TODAY }]);
  });

  it('createCsvAccount has the same Date.now() id scheme (collides in the same millisecond)', async () => {
    const a = await createCsvAccount('A', 'depository', 'checking');
    expect(a.startsWith('csv-acct-')).toBe(true);
    await expect(createCsvAccount('B', 'depository', 'checking')).rejects.toThrow(/UNIQUE|constraint/i);
  });
});

describe('updateAccountValue', () => {
  it('twice on the same day leaves one row holding the last value', async () => {
    const id = await createManualAccount('Home', 100);
    await updateAccountValue(id, 200);
    await updateAccountValue(id, 300);
    expect(await history(id)).toEqual([{ balance: 300, date: TODAY }]);
  });

  it('a new day adds a row', async () => {
    const id = await createManualAccount('Home', 100);
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    await updateAccountValue(id, 150);
    expect(await history(id)).toEqual([{ balance: 100, date: TODAY }, { balance: 150, date: '2026-10-03' }]);
  });

  it('stores zero and negative (liability) values as given', async () => {
    const id = await createManualAccount('Loan', 100);
    await updateAccountValue(id, 0);
    expect(await history(id)).toEqual([{ balance: 0, date: TODAY }]);
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    await updateAccountValue(id, -5000);
    expect((await history(id)).at(-1)).toEqual({ balance: -5000, date: '2026-10-03' });
  });

  // Current behavior: no existence check, no FK -> an orphan balance_history row
  // is written for an account that does not exist. Pinned, not endorsed.
  it('unknown account id writes an orphan balance_history row and creates no account', async () => {
    await expect(updateAccountValue('nope', 42)).resolves.toBeUndefined();
    expect(await history('nope')).toEqual([{ balance: 42, date: TODAY }]);
    expect(await accountRows()).toHaveLength(0);
  });
});

describe('updateAccountApr', () => {
  async function aprOf(id: string) {
    const acct = (await getLinkedAccounts()).find((a) => a.id === id);
    return acct?.apr;
  }

  it('sets 19.99 unscaled, then null clears it', async () => {
    const id = await createManualAccount('Card', -100);
    await updateAccountApr(id, 19.99);
    expect(await aprOf(id)).toBe(19.99);
    await updateAccountApr(id, null);
    expect(await aprOf(id)).toBeNull();
  });

  it('unknown id is a silent no-op', async () => {
    await expect(updateAccountApr('nope', 5)).resolves.toBeUndefined();
    expect(await accountRows()).toHaveLength(0);
  });
});

describe('deleteTransaction', () => {
  async function tagTx(txId: string) {
    await db.execute("INSERT INTO tags (name) VALUES ('t')");
    const tagId = Number((await db.execute("SELECT id FROM tags WHERE name='t'")).rows[0].id);
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [txId, tagId] });
    return tagId;
  }

  it('removes tag links without an FK failure', async () => {
    const tx = await seedTx(db);
    await tagTx(tx.id);
    await expect(deleteTransaction(tx.id)).resolves.toBeUndefined();
    expect((await db.execute('SELECT * FROM transaction_tags')).rows).toHaveLength(0);
    expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(0);
  });

  // Named behavior: unlike sync's removal path (cascadeDeleteTransactionsSql),
  // deleteTransaction does not clear tag_rule_suppressions. Harmless today (a
  // suppression only matters for an existing tx id) but it is leaked state.
  it('leaves orphan suppression rows', async () => {
    const tx = await seedTx(db);
    const tagId = await tagTx(tx.id);
    await db.execute({ sql: 'INSERT INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: [tx.id, tagId] });
    await deleteTransaction(tx.id);
    const sup = await db.execute({ sql: 'SELECT * FROM tag_rule_suppressions WHERE transaction_id = ?', args: [tx.id] });
    expect(sup.rows).toHaveLength(1);
  });

  it('deleting an unknown id is a no-op', async () => {
    await expect(deleteTransaction('nope')).resolves.toBeUndefined();
  });

  describe('resync (no tombstone)', () => {
    async function setupItem() {
      await db.execute({ sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?,?,?)', args: ['item-1', 'tok', 'Bank'] });
    }
    const feed = (txns: object[]) =>
      vi.mocked(getPlaidClient).mockReturnValue(makeFakePlaid({
        pages: [{ added: txns }], accounts: [makePlaidAccount()],
      }) as never);
    const count = async (id: string) =>
      (await db.execute({ sql: 'SELECT id FROM transactions WHERE id = ?', args: [id] })).rows.length;

    // Named behavior: deleteTransaction leaves no tombstone, so replaying the
    // Plaid feed (cursor reset) brings the row back. A future tombstone feature
    // must change this test consciously.
    it('a Plaid-sourced row deleted by the user is resurrected by a cursor-zero resync', async () => {
      await setupItem();
      feed([makePlaidTx({ transaction_id: 'p-1' })]);
      await syncTransactions('tok', 'item-1');
      expect(await count('p-1')).toBe(1);

      await deleteTransaction('p-1');
      expect(await count('p-1')).toBe(0);

      await deleteSyncCursor('item-1');
      feed([makePlaidTx({ transaction_id: 'p-1' })]);
      await syncTransactions('tok', 'item-1');
      expect(await count('p-1')).toBe(1);
    });

    it('a manual-source row stays deleted after a resync', async () => {
      await setupItem();
      feed([]);
      await syncTransactions('tok', 'item-1'); // creates acct-1
      const id = await addTransaction({ accountId: 'acct-1', date: '2026-09-01', name: 'Cash', amount: 5, category: 'Food' });
      expect(await count(id)).toBe(1);

      await deleteTransaction(id);
      await deleteSyncCursor('item-1');
      feed([makePlaidTx({ transaction_id: 'p-2' })]);
      await syncTransactions('tok', 'item-1');

      expect(await count(id)).toBe(0);
      expect(await count('p-2')).toBe(1);
    });
  });
});
