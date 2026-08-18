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
import { importCsvTransactions, type ImportConfig } from '../../core/accounts.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

const CFG: ImportConfig = {
  amountMode: 'single', dateCol: 0, nameCol: 1, amountCol: 2,
  debitCol: null, creditCol: null, positiveIsInflow: false,
};

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
