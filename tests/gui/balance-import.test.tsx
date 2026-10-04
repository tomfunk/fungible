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
import { SKIPPED_LIST_CAP } from '../../gui/renderer/src/components/BalanceHistoryImportModal.js';

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
  it('gives an ambiguous name a dropdown limited to its candidates and re-previews with accountMap', async () => {
    await db.execute("INSERT INTO accounts (id, name, nickname, type) VALUES ('oth', 'Other', 'Checking', 'depository')");
    picked = { path: '/x/a.csv', fileName: 'a.csv', text: 'date,account,balance\n2026-04-01,Checking,1000' };
    await openModal();
    await screen.findByText('Unmatched accounts');
    const row = screen.getByText('(ambiguous)').closest('tr')!;
    const select = within(row).getByRole('combobox');
    const opts = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(opts.map((o) => o.value).sort()).toEqual(['', 'chk', 'oth']);
    expect(opts[0].textContent).toBe('Skip');
    expect((select as HTMLSelectElement).value).toBe('');
    await userEvent.selectOptions(select, 'oth');
    await waitFor(() => expect(screen.getByText(/1 balances will be added/)).toBeTruthy());
    const previews = calls.filter((c) => c.fn === 'previewBalanceImport');
    expect(previews.length).toBe(2);
    expect((previews[1].args[1] as { accountMap: unknown }).accountMap).toEqual({ Checking: 'oth' });
  });

  it('summarizes mixed skip reasons in the preview line', async () => {
    picked = {
      path: '/x/m.csv',
      fileName: 'm.csv',
      text: ['date,account,balance', '2026-04-01,Checking,1000', '2026-04-02,Nobody,5', '2026-04-03,Ghost,5', '2026-04-04,Checking,oops'].join('\n'),
    };
    await openModal();
    const el = await screen.findByText(/balances will be added/);
    expect(el.textContent).toContain('1 balances will be added, 0 will replace existing values, 3 skipped');
    expect(el.textContent).toContain('(2 no matching account, 1 invalid date or amount)');
  });

  it('shows "skipped by you" for a row mapped to Skip', async () => {
    // A name mapped to null (Skip) is user_skipped. The UI can't pre-seed that, so inject the map at the bridge.
    const b = (window as unknown as { __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> } }).__bridge;
    const wrapped = b.call;
    b.call = (ns, fn, args) =>
      fn === 'previewBalanceImport' ? wrapped(ns, fn, [args[0], { accountMap: { Mystery: null } }]) : wrapped(ns, fn, args);
    await openModal();
    await screen.findByText(/balances will be added/);
    expect(screen.getByText(/Line 4: skipped by you/)).toBeTruthy();
    expect(screen.getByText(/balances will be added/).textContent).toContain('1 skipped by you');
  });

  it('renders the full preview line with the exact skip-reason wording', async () => {
    picked = {
      path: '/x/m.csv',
      fileName: 'm.csv',
      text: ['date,account,balance', '2026-04-01,Checking,1000', '2026-04-02,Nobody,5', '2026-04-03,Ghost,5', '2026-04-04,Checking,oops'].join('\n'),
    };
    await openModal();
    const el = await screen.findByText(/balances will be added/);
    // Literal string, so a wording change in the shared copy is a visible diff here.
    expect(el.textContent).toContain(
      '1 balances will be added, 0 will replace existing values, 3 skipped (2 no matching account, 1 invalid date or amount)',
    );
  });

  it('shows the newer-than-current reason for rows not older than the current balance', async () => {
    picked = {
      path: '/x/n.csv',
      fileName: 'n.csv',
      text: ['date,account,balance', '2026-04-01,Checking,1000', '2026-05-25,Checking,900'].join('\n'),
    };
    await openModal();
    const el = await screen.findByText(/balances will be added/);
    expect(el.textContent).toContain('(1 newer than the current balance)');
    expect(screen.getByText(/Line 3: newer than the current balance/)).toBeTruthy();
  });

  it('shows a pickText failure inline and keeps the modal open', async () => {
    const b = (window as unknown as { __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> } }).__bridge;
    const prev = b.call;
    const realMessage = 'That file is larger than 5 MB, the limit for a balance history import.';
    b.call = async (ns, fn, args) => {
      if (ns === 'files' && fn === 'pickText') throw new Error(realMessage);
      return prev(ns, fn, args);
    };
    await openModal();
    await waitFor(() => expect(screen.getByText(realMessage)).toBeTruthy());
    expect(screen.getByText('Choose a file to import.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy();
  });

  it('caps the skipped list and shows "…and N more"', async () => {
    const extra = 5;
    const rows = Array.from({ length: SKIPPED_LIST_CAP + extra }, (_, i) => `2026-04-01,Nobody${i},5`);
    picked = { path: '/x/s.csv', fileName: 's.csv', text: ['date,account,balance', ...rows].join('\n') };
    await openModal();
    await screen.findByText(/balances will be added/);
    expect(screen.getAllByText(/^Line \d+: /).length).toBe(SKIPPED_LIST_CAP);
    expect(screen.getByText(`…and ${extra} more`)).toBeTruthy();
  });

  it('closes on Escape and on backdrop click', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(/balances will be added/)).toBeNull());

    cleanup();
    await openModal();
    await screen.findByText(/balances will be added/);
    const overlay = document.querySelector('[data-modal]') as HTMLElement;
    await userEvent.pointer([{ target: overlay, keys: '[MouseLeft]' }]);
    await waitFor(() => expect(screen.queryByText(/balances will be added/)).toBeNull());
  });

  it('double-clicking Import commits once', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/Net worth history updated/)).toBeTruthy());
    expect(calls.filter((c) => c.fn === 'commitBalanceImport').length).toBe(1);
  });

  it('shows the overwrite sample and warnings for excluded accounts and negative liabilities', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, excluded) VALUES ('hid', 'Hidden', 'depository', 1)");
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('cc', 'Visa', 'credit')");
    await bal('chk', '2026-04-01', 900);
    picked = {
      path: '/x/w.csv',
      fileName: 'w.csv',
      text: ['date,account,balance', '2026-04-01,Checking,1000', '2026-04-01,Hidden,10', '2026-04-01,Visa,-50'].join('\n'),
    };
    await openModal();
    const el = await screen.findByText(/balances will be added/);
    expect(el.textContent).toContain('2 balances will be added, 1 will replace existing values');
    expect(screen.getByText('Replacing')).toBeTruthy();
    expect(screen.getByText('900.00 → 1000.00')).toBeTruthy();
    expect(screen.getByText(/Includes excluded account \(not counted in net worth\): Hidden\./)).toBeTruthy();
    expect(screen.getByText(/1 credit\/loan balance is negative/)).toBeTruthy();
  });

  it('retries successfully after a commit error', async () => {
    await openModal();
    await screen.findByText(/balances will be added/);
    const b = (window as unknown as { __bridge: { call: (ns: string, fn: string, args: unknown[]) => Promise<unknown> } }).__bridge;
    const prev = b.call;
    let failed = false;
    b.call = async (ns, fn, args) => {
      if (fn === 'commitBalanceImport' && !failed) { failed = true; throw new Error('disk full'); }
      return prev(ns, fn, args);
    };
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy());
    const btn = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByText('Net worth history updated. Added 2, replaced 0, skipped 2.')).toBeTruthy());
    expect(screen.queryByText(/disk full/)).toBeNull();
  });
});
