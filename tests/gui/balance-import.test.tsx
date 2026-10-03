// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('./../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

type Call = { ns: string; fn: string; args: unknown[] };
let calls: Call[];
let picked: { path: string; fileName: string; text: string } | null;
let pickCount: number;

/** Wraps the installed bridge so files.pickText is controllable and calls are recorded. */
function hookBridge() {
  const b = (window as unknown as { __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> } }).__bridge;
  const orig = b.call;
  b.call = async (ns, fn, args) => {
    calls.push({ ns, fn, args });
    if (ns === 'files' && fn === 'pickText') { pickCount++; return picked; }
    return orig(ns, fn, args);
  };
}

const bal = (id: string, date: string, balance: number) =>
  db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)', args: [id, balance, date] });

const CSV = [
  'date,account,balance',
  '2026-04-01,Checking,1000',
  '2026-04-02,Checking,1100',
  '2026-04-03,Mystery,50',
  '2026-04-04,Checking,oops',
].join('\n');

async function openModal() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
  await userEvent.click(await screen.findByRole('button', { name: /Import balance history/ }));
}

beforeEach(async () => {
  for (const tbl of ['transactions', 'imports', 'accounts', 'balance_history', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await db.execute("INSERT INTO accounts (id, name, type) VALUES ('chk', 'Checking', 'depository')");
  await db.execute("INSERT INTO accounts (id, name, type) VALUES ('sav', 'Savings', 'depository')");
  await bal('chk', '2026-05-20', 5000);
  calls = [];
  pickCount = 0;
  picked = { path: '/x/hist.csv', fileName: 'hist.csv', text: CSV };
  installBridge();
  hookBridge();
});

afterEach(() => cleanup());

describe('GUI Accounts — import balance history', () => {
  it('shows the card and opens the file picker on click', async () => {
    renderScreen(<Accounts />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
    expect(screen.getByText('Past balances from a date,account,balance file')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Import balance history/ }));
    await waitFor(() => expect(pickCount).toBe(1));
  });

  it('closes when the picker is cancelled', async () => {
    picked = null;
    await openModal();
    await waitFor(() => expect(pickCount).toBe(1));
    await waitFor(() => expect(screen.queryByText('Choose a file to import.')).toBeNull());
  });

  it('renders counts, reasons, unmatched accounts and skipped rows', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    const summary = screen.getByText(/balances will be added/).textContent!;
    expect(summary).toContain('2 balances will be added, 0 will replace existing values, 2 skipped');
    expect(summary).toContain('1 no matching account');
    expect(summary).toContain('1 invalid date or amount');
    expect(screen.getByText('Unmatched accounts')).toBeTruthy();
    expect(screen.getByText('Mystery')).toBeTruthy();
    expect(screen.getByText(/Line 5: invalid date or amount/)).toBeTruthy();
    expect(screen.getByText(/credit cards and loans, enter the amount owed/)).toBeTruthy();
  });

  it('re-previews with an accountMap when an unmatched name is mapped', async () => {
    await openModal();
    await screen.findByText('Unmatched accounts');
    const row = screen.getByText('Mystery').closest('tr')!;
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'sav');
    await waitFor(() => expect(screen.getByText(/3 balances will be added/)).toBeTruthy());
    const previews = calls.filter((c) => c.fn === 'previewBalanceImport');
    expect(previews.length).toBe(2);
    expect((previews[1].args[1] as { accountMap: unknown }).accountMap).toEqual({ Mystery: 'sav' });
  });

  it('disables Import when no row is valid', async () => {
    picked = { path: '/x/b.csv', fileName: 'b.csv', text: 'date,account,balance\n2026-04-03,Nobody,5' };
    await openModal();
    await screen.findByText(/0 balances will be added/);
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits the same input, reports the result and writes rows', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(screen.getByText('Net worth history updated. Added 2, replaced 0, skipped 2.')).toBeTruthy());
    const commit = calls.find((c) => c.fn === 'commitBalanceImport')!;
    expect(commit.args[0]).toBe(CSV);
    expect(commit.args[1]).toEqual({ accountMap: {} });
    const n = (await db.execute("SELECT COUNT(*) c FROM balance_history WHERE account_id = 'chk'")).rows[0].c;
    expect(Number(n)).toBe(3);
    expect(screen.queryByText('Import balance history', { selector: 'span' })).toBeNull();
  });

  it('shows a commit error inline and stays open', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    const b = (window as unknown as { __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> } }).__bridge;
    const prev = b.call;
    b.call = async (ns, fn, args) => {
      if (fn === 'commitBalanceImport') throw new Error('disk full');
      return prev(ns, fn, args);
    };
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy());
    expect(screen.getByText(/balances will be added/)).toBeTruthy();
  });
});
