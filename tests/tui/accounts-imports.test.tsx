import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { importCsvTransactions } from '../../core/accounts.js';
import { makeCsvRow } from '../helpers/makeCsvRow.js';
import { waitFor as baseWaitFor, flatFrame as flat } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { useTempCsv } from '../helpers/tempCsv.js';
import { CSV_SKIP_COPY } from '../../core/csv-import-copy.js';
import { renderAccounts } from './helpers/accountsScreen.js';
import { toAddData, toCsvFile, toCsvPreview, typePath } from './helpers/driveCsvImport.js';

const CFG = makeCsvRow();

const rows = [['2025-01-02', 'AMAZON', '25.00'], ['2025-01-05', 'NETFLIX', '15.00']];

const addAccount = (id: string, name: string, itemId: string | null = null) =>
  db.execute({
    sql: "INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'credit', 'credit card', ?)",
    args: [id, name, itemId],
  });

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tags', 'transactions',
                   'imports', 'balance_history', 'accounts', 'plaid_items', 'sync_state']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

afterEach(() => cleanup());

describe('TUI Accounts — import history', () => {
  it('is absent until something has been imported', async () => {
    const r = renderAccounts();
    await toAddData(r);
    expect(flat(r)).not.toContain('Import history');
  });

  it('lists an import with its account and row count', async () => {
    await addAccount('chase', 'Chase Sapphire');
    await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
    const r = renderAccounts();
    await toAddData(r);

    await waitFor(() => expect(flat(r)).toContain('Import history'));
    expect(flat(r)).toContain('jan.csv');
    expect(flat(r)).toContain('Chase Sapphire');
    expect(flat(r)).toContain('2025-01-02 → 2025-01-05');
  });

  it('shows rows still present alongside rows originally imported', async () => {
    await addAccount('chase', 'Chase');
    const { importId } = await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
    await db.execute(`DELETE FROM transactions WHERE id = 'csv-${importId}-0'`);
    const r = renderAccounts();
    await toAddData(r);

    await waitFor(() => expect(flat(r)).toContain('of 2'));
  });

  describe('undo', () => {
    it('confirms before removing anything', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('u');
      await waitFor(() => expect(flat(r)).toContain('Undo import — jan.csv'));
      // Nothing gone yet.
      expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(2);
    });

    it('removes the import and its transactions on Enter', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('u');
      await waitFor(() => expect(flat(r)).toContain('Undo import'));
      r.stdin.write('\r');

      await waitFor(() => expect(flat(r)).toContain('2 transactions removed'));
      expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(0);
      expect((await db.execute('SELECT * FROM imports')).rows).toHaveLength(0);
    });

    it('names the user edits it would throw away', async () => {
      await addAccount('chase', 'Chase');
      const { importId } = await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await db.execute(`UPDATE transactions SET manual_category = 'Shopping' WHERE id = 'csv-${importId}-0'`);
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('u');
      await waitFor(() => expect(flat(r)).toContain('1 with a category you set'));
    });

    it('cancels on Esc without removing anything', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('u');
      await waitFor(() => expect(flat(r)).toContain('Undo import'));
      r.stdin.write('\x1b');

      await waitFor(() => expect(flat(r)).toContain('Import history'));
      expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(2);
    });
  });

  describe('move', () => {
    it('re-points the import at the chosen account', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('v');
      await waitFor(() => expect(flat(r)).toContain('Move jan.csv to which account?'));
      r.stdin.write('\r');

      await waitFor(() => expect(flat(r)).toContain('Moved 2 transactions to Amex Gold'));
      const moved = await db.execute("SELECT COUNT(*) as n FROM transactions WHERE account_id = 'amex'");
      expect(Number((moved.rows[0] as unknown as { n: number }).n)).toBe(2);
    });

    it('does not offer the account the import is already in', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('v');
      await waitFor(() => expect(flat(r)).toContain('Move jan.csv'));
      const frame = flat(r);
      // The picker lists Amex but not the source account.
      expect(frame.slice(frame.indexOf('Move jan.csv'))).toContain('Amex Gold');
      expect(frame.slice(frame.indexOf('Move jan.csv'))).not.toContain('Chase');
    });

    it('labels a linked destination so backfilling one is deliberate', async () => {
      await addAccount('chase', 'Chase', 'item-a');
      await addAccount('csv-acct-1', 'Old Card');
      await importCsvTransactions(rows, 'csv-acct-1', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('v');
      await waitFor(() => expect(flat(r)).toContain('(linked)'));
    });

    it('reports rows the destination already held', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions([rows[0]], 'amex', CFG, { name: 'amex.csv', hash: 'h-amex' });
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      const r = renderAccounts();
      await toAddData(r);
      // Newest first, so jan.csv is the selected row.
      await waitFor(() => expect(flat(r)).toContain('jan.csv'));

      r.stdin.write('v');
      await waitFor(() => expect(flat(r)).toContain('Move jan.csv'));
      r.stdin.write('\r');

      await waitFor(() => expect(flat(r)).toContain('1 already there'));
    });
  });
});

describe('TUI Accounts — CSV import skips bad rows', () => {
  const { csv } = useTempCsv('csv-skips-');
  // File lines (header is line 1): 2 good, 3 $4.50, 4 bad amount, 5 blank amount,
  // 6 bad date, 7 missing name. Only the first five rows are previewed.
  const MIXED = [
    'Date,Description,Amount',
    '2025-01-02,AMAZON,25.00',
    '2025-01-03,COFFEE,$4.50',
    '2025-01-04,GARBAGE,12abc',
    '2025-01-05,BLANKAMT,',
    'notadate,BADDATE,9.00',
    '2025-01-07,,3.00',
  ].join('\n') + '\n';

  // The import wizard needs an account to land the rows in.
  beforeEach(async () => { await addAccount('chk', 'Checking'); });

  const txNames = async () =>
    (await db.execute('SELECT name, amount FROM transactions ORDER BY date')).rows.map((x) => [x.name, Number(x.amount)]);

  it('previews a good row and a $-prefixed amount as real amounts', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv(MIXED));
    expect(flat(r)).toMatch(/2025-01-02 AMAZON\s+\$25\.00/);
    expect(flat(r)).toMatch(/2025-01-03 COFFEE\s+\$4\.50/);
  });

  it('marks unreadable, blank and bad-date rows instead of showing $0.00 or a raw date', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv(MIXED));
    const f = flat(r);
    expect(f).toMatch(/GARBAGE\s+invalid\b/);
    expect(f).toMatch(/BLANKAMT\s+blank\b/);
    expect(f).toMatch(/invalid date\s+BADDATE/);
    expect(f).not.toContain('$0.00');
    expect(f).not.toContain('notadate');
  });

  it('counts every row that will be skipped, including ones past the preview', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv(MIXED));
    expect(flat(r)).toContain('4 rows will be skipped');
  });

  it('shows no skip footer when every row is good', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv('Date,Description,Amount\n2025-01-02,AMAZON,25.00\n'));
    expect(flat(r)).not.toContain('will be skipped');
  });

  it('reports skips with file line numbers after import and writes only the good rows', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv(MIXED));
    r.stdin.write('y');
    await waitFor(() => expect(flat(r)).toContain('Import complete'));
    const f = flat(r);
    expect(f).toContain('Imported: 2');
    expect(f).toContain(`1 ${CSV_SKIP_COPY.bad_amount}, 1 ${CSV_SKIP_COPY.empty_amount}, 1 ${CSV_SKIP_COPY.bad_date}, 1 ${CSV_SKIP_COPY.missing_name}`);
    expect(f).toContain(`line 4: ${CSV_SKIP_COPY.bad_amount}`);
    expect(f).toContain(`line 5: ${CSV_SKIP_COPY.empty_amount}`);
    expect(f).toContain(`line 6: ${CSV_SKIP_COPY.bad_date}`);
    expect(f).toContain(`line 7: ${CSV_SKIP_COPY.missing_name}`);
    expect(await txNames()).toEqual([['AMAZON', 25], ['COFFEE', 4.5]]);
  });

  it('says "1 row will be skipped" for a single bad row', async () => {
    const r = renderAccounts();
    await toCsvPreview(r, csv('Date,Description,Amount\n2025-01-02,AMAZON,25.00\n2025-01-03,GARBAGE,12abc\n'));
    expect(flat(r)).toContain('1 row will be skipped');
    expect(flat(r)).not.toContain('1 rows');
  });

  it('lists at most 5 skipped lines and counts the rest', async () => {
    const bad = Array.from({ length: 7 }, (_, i) => `2025-02-0${i + 1},BAD${i},xx`);
    const r = renderAccounts();
    await toCsvPreview(r, csv(['Date,Description,Amount', '2025-01-02,AMAZON,25.00', ...bad].join('\n') + '\n'));
    r.stdin.write('y');
    await waitFor(() => expect(flat(r)).toContain('Import complete'));
    const f = flat(r);
    expect(f.match(/line \d+:/g)).toHaveLength(5);
    expect(f).toContain('line 3:');
    expect(f).toContain('line 7:');
    expect(f).not.toContain('line 8:');
    expect(f).toContain('…and 2 more');
  });

  it('reports the true file line when a blank line precedes the bad row', async () => {
    const r = renderAccounts();
    // line 1 header, 2 good, 3 blank, 4 good, 5 bad amount (rowIndex 2 -> rowIndex+2 would say 4)
    await toCsvPreview(r, csv('Date,Description,Amount\n2025-01-02,AMAZON,25.00\n\n2025-01-03,COFFEE,4.50\n2025-01-04,GARBAGE,xx\n'));
    r.stdin.write('y');
    await waitFor(() => expect(flat(r)).toContain('Import complete'));
    expect(flat(r)).toContain(`line 5: ${CSV_SKIP_COPY.bad_amount}`);
    expect(flat(r)).not.toContain('line 4:');
  });

  it('reports the true file line when a quoted embedded newline precedes the bad row', async () => {
    const r = renderAccounts();
    // record 1 spans lines 2-3, so the bad row starts on line 4 (rowIndex+2 would say 3)
    await toCsvPreview(r, csv('Date,Description,Amount\n2025-01-02,"AMAZON\nPRIME",25.00\n2025-01-04,GARBAGE,xx\n'));
    r.stdin.write('y');
    await waitFor(() => expect(flat(r)).toContain('Import complete'));
    expect(flat(r)).toContain(`line 4: ${CSV_SKIP_COPY.bad_amount}`);
    expect(flat(r)).not.toContain('line 3:');
  });

  it('shows the unterminated-quote error and stays on the path step', async () => {
    const r = renderAccounts();
    const path = csv('Date,Description,Amount\n2025-01-02,"AMAZON,25.00\n2025-01-03,X,1.00\n');
    await toCsvFile(r);
    await typePath(r, path);
    await waitFor(() => expect(flat(r)).toContain('CSV has an unterminated quote starting on line 2'));
    expect(flat(r)).toContain('path to your CSV file');
    expect(flat(r)).not.toContain('Which column is the DATE?');
  });
});
