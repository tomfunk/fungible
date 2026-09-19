import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { importCsvTransactions, deleteAccount, type ImportConfig } from '../core/accounts.js';
import {
  getImports, getImportsOfFile, getImportImpact, deleteImport, moveImport,
} from '../core/imports.js';

const CFG: ImportConfig = {
  amountMode: 'single', dateCol: 0, nameCol: 1, amountCol: 2,
  debitCol: null, creditCol: null, positiveIsInflow: false,
};

async function account(id: string) {
  await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES (?, ?, 'credit')", args: [id, id] });
}

async function importFile(rows: string[][], accountId = 'chase', file = { name: 'jan.csv', hash: 'h-jan' }) {
  return importCsvTransactions(rows, accountId, CFG, file);
}

async function txRows(accountId?: string) {
  const sql = accountId
    ? 'SELECT * FROM transactions WHERE account_id = ? ORDER BY id'
    : 'SELECT * FROM transactions ORDER BY id';
  const r = await db.execute(accountId ? { sql, args: [accountId] } : sql);
  return r.rows as unknown as Record<string, string | number | null>[];
}

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tags', 'transactions', 'imports', 'accounts']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

describe('importCsvTransactions provenance', () => {
  it('records the file and links every row to it', async () => {
    await account('chase');
    const result = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['2025-01-05', 'NETFLIX', '15.00'],
    ]);

    expect(result.imported).toBe(2);
    const [record] = await getImports();
    expect(record).toMatchObject({
      account_id: 'chase', account_name: 'chase', file_name: 'jan.csv', file_hash: 'h-jan',
      row_count: 2, imported: 2, skipped: 0, min_date: '2025-01-02', max_date: '2025-01-05', present: 2,
    });

    const rows = await txRows();
    expect(rows.map((r) => r.id)).toEqual([`csv-${result.importId}-0`, `csv-${result.importId}-1`]);
    expect(rows.every((r) => r.source === 'csv')).toBe(true);
    expect(rows.every((r) => Number(r.import_id) === result.importId)).toBe(true);
    expect(rows.every((r) => typeof r.dedup_key === 'string')).toBe(true);
  });

  it('stores the column mapping so a re-import need not start over', async () => {
    await account('chase');
    await importFile([['2025-01-02', 'AMAZON', '25.00']]);
    const record = (await db.execute('SELECT config FROM imports')).rows[0] as unknown as { config: string };
    expect(JSON.parse(record.config)).toEqual(CFG);
  });

  // The old hash-of-content key collapsed these into one row and reported the
  // second as "skipped" — invisible under-import over a long backfill.
  it('imports two genuinely identical charges on the same day', async () => {
    await account('chase');
    const result = await importFile([
      ['2025-01-02', 'COFFEE', '4.50'],
      ['2025-01-02', 'COFFEE', '4.50'],
    ]);
    expect(result).toMatchObject({ imported: 2, skipped: 0 });
    expect(await txRows()).toHaveLength(2);
  });

  it('counts unparseable rows as skipped without opening a gap in the ids', async () => {
    await account('chase');
    const result = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['', '', ''],
      ['2025-01-04', 'NETFLIX', '15.00'],
    ]);
    expect(result).toMatchObject({ imported: 2, skipped: 1 });
    // Row index is the line in the file, so the third row keeps index 2.
    expect((await txRows()).map((r) => r.id))
      .toEqual([`csv-${result.importId}-0`, `csv-${result.importId}-2`]);
  });

  describe('idempotency', () => {
    it('imports nothing the second time the same file is imported', async () => {
      await account('chase');
      const rows = [['2025-01-02', 'AMAZON', '25.00'], ['2025-01-05', 'NETFLIX', '15.00']];
      await importFile(rows);
      const second = await importFile(rows);
      expect(second).toMatchObject({ imported: 0, skipped: 2 });
      expect(await txRows()).toHaveLength(2);
    });

    it('imports only the new rows of an overlapping statement', async () => {
      await account('chase');
      await importFile([['2025-01-02', 'AMAZON', '25.00'], ['2025-01-05', 'NETFLIX', '15.00']]);
      const second = await importFile(
        [['2025-01-05', 'NETFLIX', '15.00'], ['2025-01-09', 'SPOTIFY', '11.00']],
        'chase', { name: 'feb.csv', hash: 'h-feb' },
      );
      expect(second).toMatchObject({ imported: 1, skipped: 1 });
      expect(await txRows()).toHaveLength(3);
    });

    it('still recognises repeat charges on re-import rather than duplicating them', async () => {
      await account('chase');
      const rows = [['2025-01-02', 'COFFEE', '4.50'], ['2025-01-02', 'COFFEE', '4.50']];
      await importFile(rows);
      expect(await importFile(rows)).toMatchObject({ imported: 0, skipped: 2 });
      expect(await txRows()).toHaveLength(2);
    });

    it('scopes idempotency to the account — the same statement can land in two', async () => {
      await account('chase');
      await account('amex');
      const rows = [['2025-01-02', 'AMAZON', '25.00']];
      await importFile(rows, 'chase');
      expect(await importFile(rows, 'amex')).toMatchObject({ imported: 1 });
      expect(await txRows()).toHaveLength(2);
    });
  });

  it('finds a prior import of the same bytes under a different name', async () => {
    await account('chase');
    await importFile([['2025-01-02', 'AMAZON', '25.00']], 'chase', { name: 'statement.csv', hash: 'h-same' });
    const prior = await getImportsOfFile('h-same');
    expect(prior).toHaveLength(1);
    expect(prior[0].file_name).toBe('statement.csv');
    expect(await getImportsOfFile('h-other')).toEqual([]);
  });
});

describe('getImports', () => {
  it('reports rows still present separately from rows imported', async () => {
    await account('chase');
    const { importId } = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['2025-01-05', 'NETFLIX', '15.00'],
    ]);
    await db.execute(`DELETE FROM transactions WHERE id = 'csv-${importId}-0'`);

    const [record] = await getImports();
    expect(record.imported).toBe(2);
    expect(record.present).toBe(1);
  });

  it('survives the account being deleted out from under it', async () => {
    const { importId } = await importFile([['2025-01-02', 'AMAZON', '25.00']], 'ghost');
    const [record] = await getImports();
    expect(record.id).toBe(importId);
    expect(record.account_name).toBe('');
  });

  it('lists newest first', async () => {
    await account('chase');
    const first = await importFile([['2025-01-02', 'AMAZON', '25.00']], 'chase', { name: 'a.csv', hash: 'h-a' });
    const second = await importFile([['2025-02-02', 'NETFLIX', '15.00']], 'chase', { name: 'b.csv', hash: 'h-b' });
    expect((await getImports()).map((i) => i.id)).toEqual([second.importId, first.importId]);
  });
});

describe('getImportImpact', () => {
  it('counts the user-authored data an undo would destroy', async () => {
    await account('chase');
    const { importId } = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['2025-01-05', 'NETFLIX', '15.00'],
      ['2025-01-09', 'SPOTIFY', '11.00'],
    ]);
    await db.execute(`UPDATE transactions SET manual_category = 'Shopping' WHERE id = 'csv-${importId}-0'`);
    await db.execute(`UPDATE transactions SET display_name = 'Streaming' WHERE id = 'csv-${importId}-1'`);
    await db.execute("INSERT INTO tags (id, name) VALUES (1, 'trip')");
    await db.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-${importId}-2', 1)`);

    expect(await getImportImpact(importId)).toEqual({
      present: 3, manualCategories: 1, renamed: 1, tagged: 1,
    });
  });

  it('reports zeroes for an import whose rows are all gone', async () => {
    await account('chase');
    const { importId } = await importFile([['2025-01-02', 'AMAZON', '25.00']]);
    await db.execute('DELETE FROM transactions');
    expect(await getImportImpact(importId)).toEqual({
      present: 0, manualCategories: 0, renamed: 0, tagged: 0,
    });
  });
});

describe('deleteImport', () => {
  it('removes the rows, their tags, and the record', async () => {
    await account('chase');
    const { importId } = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['2025-01-05', 'NETFLIX', '15.00'],
    ]);
    await db.execute("INSERT INTO tags (id, name) VALUES (1, 'trip')");
    await db.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-${importId}-0', 1)`);
    await db.execute(`INSERT INTO tag_rule_suppressions (transaction_id, tag_id) VALUES ('csv-${importId}-1', 1)`);

    expect(await deleteImport(importId)).toBe(2);
    expect(await txRows()).toHaveLength(0);
    expect(await getImports()).toEqual([]);
    expect((await db.execute('SELECT * FROM transaction_tags')).rows).toHaveLength(0);
    expect((await db.execute('SELECT * FROM tag_rule_suppressions')).rows).toHaveLength(0);
  });

  it('leaves other imports untouched', async () => {
    await account('chase');
    const keep = await importFile([['2025-01-02', 'AMAZON', '25.00']], 'chase', { name: 'a.csv', hash: 'h-a' });
    const drop = await importFile([['2025-02-02', 'NETFLIX', '15.00']], 'chase', { name: 'b.csv', hash: 'h-b' });

    await deleteImport(drop.importId);
    expect((await getImports()).map((i) => i.id)).toEqual([keep.importId]);
    expect((await txRows()).map((r) => r.id)).toEqual([`csv-${keep.importId}-0`]);
  });

  // Sync folds CSV rows into their Plaid counterparts, so an import's rows can
  // already be gone. Undo has nothing to remove and must not fail.
  it('removes the record when the rows are already gone', async () => {
    await account('chase');
    const { importId } = await importFile([['2025-01-02', 'AMAZON', '25.00']]);
    await db.execute('DELETE FROM transactions');
    expect(await deleteImport(importId)).toBe(0);
    expect(await getImports()).toEqual([]);
  });

  it('frees the file to be imported again', async () => {
    await account('chase');
    const rows = [['2025-01-02', 'AMAZON', '25.00']];
    const first = await importFile(rows);
    await deleteImport(first.importId);
    expect(await importFile(rows)).toMatchObject({ imported: 1, skipped: 0 });
  });
});

describe('moveImport', () => {
  it('re-points the rows and the record without touching ids', async () => {
    await account('chase');
    await account('amex');
    const { importId } = await importFile([
      ['2025-01-02', 'AMAZON', '25.00'],
      ['2025-01-05', 'NETFLIX', '15.00'],
    ]);

    expect(await moveImport(importId, 'amex')).toEqual({ moved: 2, displaced: 0 });
    expect(await txRows('chase')).toHaveLength(0);
    expect((await txRows('amex')).map((r) => r.id))
      .toEqual([`csv-${importId}-0`, `csv-${importId}-1`]);
    expect((await getImports())[0].account_id).toBe('amex');
  });

  // Ids are the whole reason this is cheap: tags are keyed by transaction id, so
  // they ride along without being rewritten.
  it('keeps tags attached to the moved rows', async () => {
    await account('chase');
    await account('amex');
    const { importId } = await importFile([['2025-01-02', 'AMAZON', '25.00']]);
    await db.execute("INSERT INTO tags (id, name) VALUES (1, 'trip')");
    await db.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-${importId}-0', 1)`);

    await moveImport(importId, 'amex');
    const tagged = await db.execute('SELECT transaction_id FROM transaction_tags');
    expect(tagged.rows).toHaveLength(1);
    expect((tagged.rows[0] as unknown as { transaction_id: string }).transaction_id)
      .toBe(`csv-${importId}-0`);
  });

  it('drops rows the destination already holds, keeping the destination copy', async () => {
    await account('chase');
    await account('amex');
    const rows = [['2025-01-02', 'AMAZON', '25.00'], ['2025-01-05', 'NETFLIX', '15.00']];
    const target = await importFile([rows[0]], 'amex', { name: 'amex.csv', hash: 'h-amex' });
    const wrong = await importFile(rows, 'chase');

    expect(await moveImport(wrong.importId, 'amex')).toEqual({ moved: 1, displaced: 1 });
    const remaining = (await txRows('amex')).map((r) => r.id);
    expect(remaining).toContain(`csv-${target.importId}-0`);   // destination's copy survives
    expect(remaining).not.toContain(`csv-${wrong.importId}-0`); // the duplicate does not
    expect(remaining).toContain(`csv-${wrong.importId}-1`);     // the new row moves
  });

  it('is a no-op for an import whose rows are gone', async () => {
    await account('chase');
    await account('amex');
    const { importId } = await importFile([['2025-01-02', 'AMAZON', '25.00']]);
    await db.execute('DELETE FROM transactions');
    expect(await moveImport(importId, 'amex')).toEqual({ moved: 0, displaced: 0 });
    expect((await getImports())[0].account_id).toBe('amex');
  });
});

describe('deleteAccount', () => {
  it('takes the account\'s import records with it', async () => {
    await account('chase');
    await account('amex');
    await importFile([['2025-01-02', 'AMAZON', '25.00']], 'chase');
    const keep = await importFile([['2025-01-02', 'AMAZON', '25.00']], 'amex', { name: 'b.csv', hash: 'h-b' });

    await deleteAccount('chase');
    expect((await getImports()).map((i) => i.id)).toEqual([keep.importId]);
  });
});
