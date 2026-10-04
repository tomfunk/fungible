// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { useFixedClock } from '../helpers/fakeClock.js';
import { seedPlaidAccount } from '../helpers/balanceFixtures.js';
import { readAccount, countRows } from '../helpers/readDb.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

// updateAccountValue stamps `new Date().toISOString().slice(0, 10)`.
const TODAY = '2026-10-02';
useFixedClock(`${TODAY}T12:00:00Z`);

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;
const rowBtn = (name: string, label: string) =>
  within(rowOf(name)).getByRole('button', { name: label });

async function seedManual(id = 'manual-1', name = 'Lake House', balance = 500000) {
  await db.execute({ sql: "INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, 'other', 'manual')", args: [id, name] });
  await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, '2026-09-01')", args: [id, balance] });
}

async function balances(id: string) {
  const r = await db.execute({ sql: 'SELECT date, balance FROM balance_history WHERE account_id = ? ORDER BY date', args: [id] });
  return r.rows.map((x) => ({ date: String(x.date), balance: Number(x.balance) }));
}

describe('GUI Accounts: manual value modal', () => {
  it("saving '$450,000' writes today's balance_history row and reports it", async () => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    await userEvent.click(rowBtn('Lake House', 'value'));
    await userEvent.type(await screen.findByRole('textbox'), '$450,000');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Updated value for Lake House')).toBeTruthy());
    expect(await balances('manual-1')).toEqual([
      { date: '2026-09-01', balance: 500000 }, // history preserved
      { date: TODAY, balance: 450000 },
    ]);
  });

  it("re-saving on the same day replaces today's row rather than adding a second", async () => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    for (const v of ['450000', '460000']) {
      await userEvent.click(rowBtn('Lake House', 'value'));
      await userEvent.type(await screen.findByRole('textbox'), v);
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    }
    expect(await countRows(db, 'balance_history', 'account_id = ? AND date = ?', ['manual-1', TODAY])).toBe(1);
    expect((await balances('manual-1')).at(-1)).toEqual({ date: TODAY, balance: 460000 });
  });

  it.each([['-5'], ['abc'], ['']])('rejects %j with an error and writes nothing', async (input) => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    await userEvent.click(rowBtn('Lake House', 'value'));
    const box = await screen.findByRole('textbox');
    if (input) await userEvent.type(box, input);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid positive number')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy(); // modal stays open
    expect(await balances('manual-1')).toEqual([{ date: '2026-09-01', balance: 500000 }]);
  });

  it('accepts 0 as a valid value', async () => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    await userEvent.click(rowBtn('Lake House', 'value'));
    await userEvent.type(await screen.findByRole('textbox'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Updated value for Lake House')).toBeTruthy());
    expect((await balances('manual-1')).at(-1)).toEqual({ date: TODAY, balance: 0 });
  });

  it('shows the value button only on manual- accounts', async () => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    expect(within(rowOf('Lake House')).queryByRole('button', { name: 'value' })).toBeTruthy();
    expect(within(rowOf('Test Checking')).queryByRole('button', { name: 'value' })).toBeNull();
    expect(within(rowOf('Test Visa')).queryByRole('button', { name: 'value' })).toBeNull();
  });
});

describe('GUI Accounts: edit account modal', () => {
  const selects = () => screen.getAllByRole('combobox') as HTMLSelectElement[]; // [owner?, type, subtype?]

  async function openEdit(name: string) {
    renderScreen(<Accounts />);
    await screen.findByText(name);
    await userEvent.click(rowBtn(name, 'edit'));
    await screen.findByPlaceholderText('none');
  }
  async function save(name: string) {
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(`Updated ${name}`)).toBeTruthy());
  }

  it('assigns an owner from the household members, and Unassigned writes NULL', async () => {
    await db.execute("INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Alex', 1990, 0)");
    await openEdit('Test Checking');
    await userEvent.selectOptions(selects()[0], 'Alex');
    await save('Test Checking');
    expect((await readAccount(db, 'test-checking'))!.owner).toBe('Alex');
    await waitFor(() => expect(rowOf('Test Checking').textContent).toContain('Alex'));

    await userEvent.click(rowBtn('Test Checking', 'edit'));
    await screen.findByPlaceholderText('none');
    expect(selects()[0].value).toBe('Alex');
    await userEvent.selectOptions(selects()[0], 'Unassigned');
    await save('Test Checking');
    expect((await readAccount(db, 'test-checking'))!.owner).toBeNull();
  });

  it('tells the user to add household members when there are none', async () => {
    await openEdit('Test Checking');
    expect(screen.getByText('Add household members in Settings')).toBeTruthy();
    await save('Test Checking');
    expect((await readAccount(db, 'test-checking'))!.owner).toBeNull();
  });

  it("changing type depository -> investment resets the subtype to the new type's first option", async () => {
    await openEdit('Test Checking');
    // no members -> selects are [type, subtype]
    const [type, subtype] = selects();
    expect(type.value).toBe('depository');
    expect(subtype.value).toBe('checking');
    await userEvent.selectOptions(type, 'investment');
    expect(selects()[1].value).toBe('brokerage');
    await save('Test Checking');
    const a = (await readAccount(db, 'test-checking'))!;
    expect(a.type).toBe('investment');
    expect(a.subtype).toBe('brokerage');
  });

  it('shows APR only for credit/loan accounts, strips non-numeric input, and persists it', async () => {
    await openEdit('Test Checking');
    expect(screen.queryByPlaceholderText('0.0')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('none')).toBeNull());

    await userEvent.click(rowBtn('Test Visa', 'edit'));
    await screen.findByPlaceholderText('none');
    const apr = screen.getByPlaceholderText('0.0') as HTMLInputElement;
    await userEvent.type(apr, '2a4.9b9');
    expect(apr.value).toBe('24.99');
    await save('Test Visa');
    expect((await readAccount(db, 'test-credit'))!.apr).toBe(24.99);
  });

  it('an APR typed before switching the type away from credit/loan is not written', async () => {
    await db.execute("UPDATE accounts SET apr = 19.5 WHERE id = 'test-credit'");
    renderScreen(<Accounts />);
    await screen.findByText('Test Visa');
    await userEvent.click(rowBtn('Test Visa', 'edit'));
    await screen.findByPlaceholderText('none');
    const apr = screen.getByPlaceholderText('0.0') as HTMLInputElement;
    expect(apr.value).toBe('19.5');
    await userEvent.clear(apr);
    await userEvent.type(apr, '24');
    await userEvent.selectOptions(selects()[0], 'depository');
    expect(screen.queryByPlaceholderText('0.0')).toBeNull();
    await save('Test Visa');
    const a = (await readAccount(db, 'test-credit'))!;
    expect(a.type).toBe('depository');
    expect(a.apr).toBe(19.5); // the hidden field's edit is discarded
  });

  it('clearing the APR field writes NULL', async () => {
    await db.execute("UPDATE accounts SET apr = 19.5 WHERE id = 'test-credit'");
    renderScreen(<Accounts />);
    await screen.findByText('Test Visa');
    await userEvent.click(rowBtn('Test Visa', 'edit'));
    await userEvent.clear(await screen.findByPlaceholderText('0.0'));
    await save('Test Visa');
    expect((await readAccount(db, 'test-credit'))!.apr).toBeNull();
  });

  it('Exclude from net worth persists excluded=1 and shows the marker', async () => {
    await openEdit('Test Checking');
    await userEvent.click(screen.getByRole('checkbox'));
    await save('Test Checking');
    expect((await readAccount(db, 'test-checking'))!.excluded).toBe(1);
    await waitFor(() => expect(rowOf('Test Checking').textContent).toContain('excl'));
  });

  it('nickname is saved trimmed, and clearing it writes NULL', async () => {
    await openEdit('Test Checking');
    await userEvent.type(screen.getByPlaceholderText('none'), '  Daily  ');
    await save('Daily');
    expect((await readAccount(db, 'test-checking'))!.nickname).toBe('Daily');
    await userEvent.click(rowBtn('Daily', 'edit'));
    await userEvent.clear(await screen.findByPlaceholderText('none'));
    await save('Test Checking');
    expect((await readAccount(db, 'test-checking'))!.nickname).toBeNull();
  });

  // PRODUCT BUG (data-destructive): EditAccountModal.save ALWAYS rewrites
  // type/subtype from modal state, even when the user only changed the nickname.
  // The initial subtype is `initialSubtypes.includes(acct.subtype) ? acct.subtype
  // : initialSubtypes[0] ?? ''`, so any subtype the constants list does not know
  // is silently replaced: a manual asset (type 'other', SUBTYPES.other = [])
  // loses subtype 'manual' to NULL, a Plaid 'certificate of deposit' becomes
  // 'checking', a depository/credit account with NULL subtype gets a made-up one.
  // Fix: only call updateAccountTypeSubtype when the type or subtype
  // field was actually changed (or seed the initial state with acct.subtype and
  // add it as an option); then flip these to plain `it`.
  it.fails('BUG: editing only the nickname of a manual asset keeps its subtype', async () => {
    await seedManual();
    renderScreen(<Accounts />);
    await screen.findByText('Lake House');
    await userEvent.click(rowBtn('Lake House', 'edit'));
    await userEvent.type(await screen.findByPlaceholderText('none'), 'Cabin');
    await save('Cabin');
    expect((await readAccount(db, 'manual-1'))!.subtype).toBe('manual');
  });

  it.fails.each([
    ['depository', 'certificate of deposit'],
    ['investment', 'crypto wallet'],
    ['loan', 'bnpl'],
  ])('BUG: editing only the nickname keeps a Plaid %s subtype not in the constants list (%s)', async (type, subtype) => {
    await seedPlaidAccount(db, { id: 'plaid-x', name: 'Odd Account', type, subtype });
    renderScreen(<Accounts />);
    await screen.findByText('Odd Account');
    await userEvent.click(rowBtn('Odd Account', 'edit'));
    await userEvent.type(await screen.findByPlaceholderText('none'), 'Renamed');
    await save('Renamed');
    expect((await readAccount(db, 'plaid-x'))!.subtype).toBe(subtype);
  });

  it.fails('BUG: editing only the nickname of an account with NULL subtype leaves it NULL', async () => {
    await seedPlaidAccount(db, { id: 'plaid-nosub', name: 'Mystery', type: 'credit', subtype: null });
    renderScreen(<Accounts />);
    await screen.findByText('Mystery');
    await userEvent.click(rowBtn('Mystery', 'edit'));
    await userEvent.type(await screen.findByPlaceholderText('none'), 'Card');
    await save('Card');
    expect((await readAccount(db, 'plaid-nosub'))!.subtype).toBeNull();
  });
});
