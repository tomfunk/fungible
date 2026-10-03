// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('./../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { importCsvTransactions } from '../../core/accounts.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';
import { makeCsvRow } from '../helpers/makeCsvRow.js';
import { summarizeCsvSkips } from '../../core/csv-import-copy.js';

const CFG = makeCsvRow();

const addAccount = (id: string, name: string, itemId: string | null = null) =>
  db.execute({
    sql: "INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'credit', 'credit card', ?)",
    args: [id, name, itemId],
  });

const rows = [['2025-01-02', 'AMAZON', '25.00'], ['2025-01-05', 'NETFLIX', '15.00']];

/** Renders the screen and switches to the Add Data tab, where history lives. */
async function addData() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
}

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'tags', 'transactions',
                     'imports', 'accounts', 'balance_history', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Accounts — import history', () => {
  it('says so plainly when nothing has been imported', async () => {
    await addData();
    await waitFor(() => expect(screen.getByText('No CSV files imported yet.')).toBeTruthy());
  });

  it('lists an import with its account, row count and date range', async () => {
    await addAccount('chase', 'Chase Sapphire');
    await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
    await addData();

    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    const row = screen.getByText('jan.csv').closest('tr')!;
    expect(row.textContent).toContain('Chase Sapphire');
    expect(row.textContent).toContain('2');
    expect(row.textContent).toContain('2025-01-02 → 2025-01-05');
  });

  // Sync folds CSV rows into their Plaid counterparts, so an import's row count
  // drifts down over time. Showing only one of the two numbers would misreport.
  it('shows rows still present alongside rows originally imported', async () => {
    await addAccount('chase', 'Chase');
    const { importId } = await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
    await db.execute(`DELETE FROM transactions WHERE id = 'csv-${importId}-0'`);
    await addData();

    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    expect(screen.getByText('jan.csv').closest('tr')!.textContent).toContain('of 2');
  });

  it('names the account as deleted rather than showing a blank', async () => {
    await importCsvTransactions(rows, 'ghost', CFG, { name: 'jan.csv', hash: 'h-jan' });
    await addData();
    await waitFor(() => expect(screen.getByText('(account deleted)')).toBeTruthy());
  });

  describe('undo', () => {
    it('removes the import and its transactions', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'undo' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Undo import' }));

      await waitFor(() => expect(screen.getByText('No CSV files imported yet.')).toBeTruthy());
      expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(0);
      expect((await db.execute('SELECT * FROM imports')).rows).toHaveLength(0);
    });

    // The counts alone don't tell the user they are about to lose work that was
    // theirs rather than the file's.
    it('warns specifically about edits the user made', async () => {
      await addAccount('chase', 'Chase');
      const { importId } = await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await db.execute(`UPDATE transactions SET manual_category = 'Shopping' WHERE id = 'csv-${importId}-0'`);
      await db.execute("INSERT INTO tags (id, name) VALUES (1, 'trip')");
      await db.execute(`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('csv-${importId}-1', 1)`);
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'undo' }));
      await waitFor(() => expect(screen.getByText(/throws away your own edits/)).toBeTruthy());
      expect(screen.getByText(/1 with a category you set/)).toBeTruthy();
      expect(screen.getByText(/1 tagged/)).toBeTruthy();
    });

    it('says nothing about edits when there are none', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'undo' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Undo import' })).toBeTruthy());
      expect(screen.queryByText(/throws away your own edits/)).toBeNull();
    });

    it('leaves everything alone when cancelled', async () => {
      await addAccount('chase', 'Chase');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'undo' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
      expect((await db.execute('SELECT * FROM transactions')).rows).toHaveLength(2);
    });
  });

  describe('move', () => {
    it('re-points the import at another account', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'move…' }));
      await userEvent.selectOptions(await screen.findByRole('combobox'), 'amex');
      await userEvent.click(await screen.findByRole('button', { name: 'Move' }));

      await waitFor(() => expect(screen.getByText('jan.csv').closest('tr')!.textContent).toContain('Amex Gold'));
      const moved = await db.execute("SELECT COUNT(*) as n FROM transactions WHERE account_id = 'amex'");
      expect(Number((moved.rows[0] as unknown as { n: number }).n)).toBe(2);
    });

    it('does not offer the account the import is already in', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'move…' }));
      const options = Array.from((await screen.findByRole('combobox')).querySelectorAll('option'));
      expect(options.map((o) => o.textContent)).not.toContain('Chase');
      expect(options.map((o) => o.textContent)).toContain('Amex Gold');
    });

    it('groups the destinations so a linked account is a deliberate choice', async () => {
      await addAccount('chase', 'Chase', 'item-a');
      await addAccount('csv-acct-1', 'Old Card');
      await importCsvTransactions(rows, 'csv-acct-1', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      await userEvent.click(await screen.findByRole('button', { name: 'move…' }));
      const groups = Array.from((await screen.findByRole('combobox')).querySelectorAll('optgroup'));
      expect(groups.map((g) => g.getAttribute('label'))).toContain('Linked accounts');
    });

    it('reports rows the destination already held', async () => {
      await addAccount('chase', 'Chase');
      await addAccount('amex', 'Amex Gold');
      await importCsvTransactions([rows[0]], 'amex', CFG, { name: 'amex.csv', hash: 'h-amex' });
      await importCsvTransactions(rows, 'chase', CFG, { name: 'jan.csv', hash: 'h-jan' });
      await addData();

      const moveButtons = await screen.findAllByRole('button', { name: 'move…' });
      // Newest first, so jan.csv — the one to re-point — is the first row.
      await userEvent.click(moveButtons[0]);
      await userEvent.selectOptions(await screen.findByRole('combobox'), 'amex');
      await userEvent.click(await screen.findByRole('button', { name: 'Move' }));

      await waitFor(() => expect(screen.getByText(/1 already there/)).toBeTruthy());
    });
  });
});

describe('GUI Accounts — CSV import modal', () => {
  const headers = ['Date', 'Description', 'Amount'];
  // File lines: header is 1, so data row i is on line i + 2.
  const mixed = [
    ['2025-01-02', 'AMAZON', '25.00'],   // line 2 good
    ['2025-01-03', 'COFFEE', '$4.50'],   // line 3 good, dollar sign
    ['2025-01-04', 'GARBLED', 'abc'],    // line 4 bad amount
    ['2025-01-05', 'NOAMOUNT', ''],      // line 5 blank amount
    ['2025-13-45', 'BADDATE', '5.00'],   // line 6 bad date
  ];

  /** Opens the import modal with `fileRows` as the picked file and maps Amount. */
  async function openModal(fileRows: string[][]) {
    await addAccount('chase', 'Chase');
    const bridge = (window as unknown as { __bridge: { call: (...a: unknown[]) => Promise<unknown> } }).__bridge;
    const realCall = bridge.call;
    bridge.call = async (ns, fn, args) =>
      ns === 'files' && fn === 'pickCsv'
        ? { path: '/tmp/x.csv', headers, rows: fileRows, fileName: 'x.csv', fileHash: 'h-x' }
        : realCall(ns, fn, args);
    await addData();
    await userEvent.click(await screen.findByText('Import CSV'));
    // Selects in order: date, description, amount mode, amount column, positive-means, account.
    const selects = await screen.findAllByRole('combobox');
    await userEvent.selectOptions(selects[3], '2');
  }

  const amountCells = () =>
    Array.from(document.querySelectorAll('[data-amount-state]')).map((c) => [c.getAttribute('data-amount-state'), c.textContent]);

  it('previews a good row with its date and amount', async () => {
    await openModal([mixed[0]]);
    await waitFor(() => expect(amountCells()).toEqual([['ok', '$25.00']]));
    expect(document.querySelector('[data-date-state="ok"]')!.textContent).toBe('2025-01-02');
    expect(screen.queryByText(/will be skipped/)).toBeNull();
  });

  it('previews a $-prefixed amount as its value, not $0.00', async () => {
    await openModal([mixed[1]]);
    await waitFor(() => expect(amountCells()).toEqual([['ok', '$4.50']]));
  });

  it('marks an unreadable amount invalid instead of $0.00', async () => {
    await openModal([mixed[2]]);
    await waitFor(() => expect(amountCells()).toEqual([['invalid', 'invalid']]));
  });

  it('marks a blank amount blank instead of $0.00', async () => {
    await openModal([mixed[3]]);
    await waitFor(() => expect(amountCells()).toEqual([['blank', 'blank']]));
  });

  it('marks an invalid date instead of echoing the raw text', async () => {
    await openModal([mixed[4]]);
    await waitFor(() => expect(document.querySelector('[data-date-state="invalid"]')!.textContent).toBe('invalid date'));
    expect(screen.queryByText('2025-13-45')).toBeNull();
  });

  it('counts every row that will be skipped in the footer, using the shared copy', async () => {
    await openModal(mixed);
    const expected = summarizeCsvSkips([
      { rowIndex: 2, reason: 'bad_amount' }, { rowIndex: 3, reason: 'empty_amount' }, { rowIndex: 4, reason: 'bad_date' },
    ]);
    const footer = await screen.findByText(/will be skipped/);
    expect(footer.textContent).toContain('3 rows will be skipped');
    expect(footer.textContent).toContain(expected);
  });

  it('uses the singular for a single skipped row', async () => {
    await openModal([mixed[0], mixed[2]]);
    const footer = await screen.findByText(/will be skipped/);
    expect(footer.textContent).toContain('1 row will be skipped');
    expect(footer.textContent).not.toContain('1 rows');
  });

  it('counts a missing-description row in the footer and skips it on import', async () => {
    const noName = ['2025-01-06', '', '9.00'];
    await openModal([mixed[0], noName, mixed[2]]);
    const footer = await screen.findByText(/will be skipped/);
    expect(footer.textContent).toContain('2 rows will be skipped');
    expect(footer.textContent).toContain(summarizeCsvSkips([
      { rowIndex: 1, reason: 'missing_name' }, { rowIndex: 2, reason: 'bad_amount' },
    ]));
    await userEvent.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    const msg = await screen.findByText(/^Imported 1/);
    expect(msg.textContent).toContain('skipped 2');
    expect(msg.textContent).toMatch(/line 3: missing description/);
    const res = await db.execute('SELECT name FROM transactions');
    expect(res.rows.map((r) => r.name)).toEqual(['AMAZON']);
  });

  it('imports only the good rows and reports skips with file line numbers', async () => {
    await openModal(mixed);
    await userEvent.click(await screen.findByRole('button', { name: 'Import 5 rows' }));

    const msg = await screen.findByText(/^Imported 2/);
    expect(msg.textContent).toContain('skipped 3');
    expect(msg.textContent).toContain(summarizeCsvSkips([
      { rowIndex: 2, reason: 'bad_amount' }, { rowIndex: 3, reason: 'empty_amount' }, { rowIndex: 4, reason: 'bad_date' },
    ]));
    expect(msg.textContent).toMatch(/line 4: unreadable amount/);
    expect(msg.textContent).toMatch(/line 5: blank amount/);
    expect(msg.textContent).toMatch(/line 6: invalid date/);

    const res = await db.execute('SELECT name, date, amount FROM transactions ORDER BY date');
    expect(res.rows.map((r) => [r.name, r.date, r.amount])).toEqual([
      ['AMAZON', '2025-01-02', 25], ['COFFEE', '2025-01-03', 4.5],
    ]);
  });

  it('says "and N more" when many rows are skipped', async () => {
    const bad = Array.from({ length: 5 }, (_, i) => [`2025-01-0${i + 1}`, `BAD${i}`, 'abc']);
    await openModal(bad);
    await userEvent.click(await screen.findByRole('button', { name: 'Import 5 rows' }));
    const msg = await screen.findByText(/^Imported 0/);
    expect(msg.textContent).toContain('line 2:');
    expect(msg.textContent).toContain('and 2 more');
    expect(msg.textContent).not.toContain('line 6:');
  });
});
