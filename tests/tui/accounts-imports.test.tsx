import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { importCsvTransactions, type ImportConfig } from '../../core/accounts.js';
import { Accounts } from '../../tui/Accounts.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const flat = (r: ReturnType<typeof render>) =>
  (r.lastFrame() ?? '').replace(ANSI_RE, '').replace(/\s+/g, ' ');

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

function renderAccounts() {
  return render(
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        <Accounts onNavigate={() => {}} showHints={false} />
      </TypingContext.Provider>
    </RefreshProvider>,
  );
}

/** Tab twice: Accounts → Links → Add Data, where import history lives. */
async function toAddData(r: ReturnType<typeof render>) {
  // One tab at a time: the two writes land in the same tick otherwise and Ink
  // processes only the first.
  r.stdin.write('\t');
  await waitFor(() => expect(flat(r)).toContain('Links'));
  r.stdin.write('\t');
  await waitFor(() => expect(flat(r)).toContain('Import CSV file'));
}

const CFG: ImportConfig = {
  amountMode: 'single', dateCol: 0, nameCol: 1, amountCol: 2,
  debitCol: null, creditCol: null, positiveIsInflow: false,
};

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
