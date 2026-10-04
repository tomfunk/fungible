// DRAFT: append to tests/money-properties.test.ts or new tests/csv-cross-file-dedup.test.ts (core fief).
// Needs the same vi.mock('../core/db.js') header, beforeEach cleanup and CFG = makeCsvRow() as money-properties.test.ts.
// Why: inside ONE file, assignOrdinals buckets rows with dedupKey itself, so a dedupKey that forgot its
// date, amount or name still gives unique keys within a file. Only a SECOND file (overlapping statement)
// exposes a weakened key, and that is the real-world dedup path.
import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../core/db.js', async () => { const { makeTestDb } = await import('./helpers/makeTestDb.js'); return { db: await makeTestDb() }; });
import { db } from '../core/db.js';
import { parseCsvText } from '../core/csv.js';
import { importCsvTransactions } from '../core/accounts.js';
import { makeCsvRow } from './helpers/makeCsvRow.js';

const CFG = makeCsvRow();
const countTx = async (acct = 'acc') => Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?', args: [acct] })).rows[0].n);
let n = 0;
async function importText(body: string, acct = 'acc') {
  const parsed = parseCsvText('Date,Name,Amount\n' + body);
  return importCsvTransactions(parsed.rows, acct, CFG, { name: `f${n}.csv`, hash: `h${n++}` }, parsed.lines);
}

beforeEach(async () => {
  for (const t of ['transactions', 'imports', 'accounts']) await db.execute(`DELETE FROM ${t}`);
  await db.execute(`INSERT INTO accounts (id, name, type) VALUES ('acc', 'acc', 'credit'), ('acc2', 'acc2', 'credit')`);
});

describe('overlapping statements (cross-file dedup)', () => {
  // One variant per file: assignOrdinals buckets rows with dedupKey too, so inside a single file a
  // weakened key (say, one that forgot the date) is masked by ordinal 1 vs 0. Single-row files keep ord=0.
  it.each([
    ['exact repeat', '2025-01-02,Coffee,4.50', 0],
    ['date differs', '2025-01-03,Coffee,4.50', 1],
    ['amount differs by one cent', '2025-01-02,Coffee,4.51', 1],
    ['name differs', '2025-01-02,Tea,4.50', 1],
    ['sign differs', '2025-01-02,Coffee,-4.50', 1],
  ])('a later statement row that is an %s of an existing row imports %i', async (_label, row, expected) => {
    await importText('2025-01-02,Coffee,4.50\n');
    const r = await importText(row + '\n');
    expect(r.imported).toBe(expected);
    expect(await countTx()).toBe(1 + expected);
  });

  it('case and surrounding whitespace in the name do not defeat dedup; 4.5 equals 4.50', async () => {
    await importText('2025-01-02,Coffee,4.50\n');
    const r = await importText('2025-01-02,"  COFFEE ",4.5\n');
    expect(r.imported).toBe(0);
    expect(await countTx()).toBe(1);
  });

  it('overlap with duplicates: 2 identical rows then a file with 3 adds exactly one', async () => {
    await importText('2025-01-02,Coffee,4.50\n2025-01-02,Coffee,4.50\n');
    const r = await importText('2025-01-02,Coffee,4.50\n2025-01-02,Coffee,4.50\n2025-01-02,Coffee,4.50\n');
    expect(r.imported).toBe(1);
    expect(await countTx()).toBe(3);
  });

  it('the same row in a different account is not a duplicate', async () => {
    await importText('2025-01-02,Coffee,4.50\n', 'acc');
    const r = await importText('2025-01-02,Coffee,4.50\n', 'acc2');
    expect(r.imported).toBe(1);
  });
});
