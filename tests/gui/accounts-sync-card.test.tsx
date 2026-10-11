// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { seedPlaidAccount } from '../helpers/balanceFixtures.js';
import { registry } from '../../gui/main/registry.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

type R = { itemId: string; added: number; modified: number; removed: number; error?: string };
const res = (itemId: string, added: number, error?: string): R => ({ itemId, added, modified: 0, removed: 0, error });

beforeEach(async () => {
  localStorage.clear();
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const syncSpy = () => vi.spyOn(registry.sync, 'syncAll');

async function openAddData() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
  return screen.findByRole('button', { name: /Force sync/ }) as Promise<HTMLButtonElement>;
}

describe('GUI Accounts: Force sync card', () => {
  it('syncs everything with force=true and reports the plural count', async () => {
    const spy = syncSpy().mockResolvedValue([res('item-a', 2), res('item-b', 1)] as never);
    await userEvent.click(await openAddData());
    await waitFor(() => expect(screen.getByText('Sync done — 3 new transactions')).toBeTruthy());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual([true]);
  });

  it.each([[1, 'Sync done — 1 new transaction'], [0, 'Sync done — 0 new transactions']])(
    'reports %i added as %j', async (added, text) => {
      syncSpy().mockResolvedValue([res('item-a', added)] as never);
      await userEvent.click(await openAddData());
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    });

  it('names the failing account by nickname when the result carries an error', async () => {
    await seedPlaidAccount(db, { id: 'plaid-1', name: 'Plaid Savings', itemId: 'item-x' });
    await db.execute("UPDATE accounts SET nickname = 'Rainy Day' WHERE id = 'plaid-1'");
    syncSpy().mockResolvedValue([res('item-x', 0, 'ITEM_LOGIN_REQUIRED')] as never);
    await userEvent.click(await openAddData());
    await waitFor(() => expect(screen.getByText('Sync failed: Rainy Day: ITEM_LOGIN_REQUIRED')).toBeTruthy());
    expect(screen.queryByText(/Sync done/)).toBeNull();
  });

  it('falls back to the item id when no account belongs to the failed item', async () => {
    syncSpy().mockResolvedValue([res('item-ghost', 0, 'boom')] as never);
    await userEvent.click(await openAddData());
    await waitFor(() => expect(screen.getByText('Sync failed: item-ghost: boom')).toBeTruthy());
  });

  it('a rejected sync shows a generic failure', async () => {
    syncSpy().mockRejectedValue(new Error('network down'));
    await userEvent.click(await openAddData());
    await waitFor(() => expect(screen.getByText('Sync failed')).toBeTruthy());
    // the card is usable again afterwards
    await waitFor(() => expect((screen.getByRole('button', { name: /Force sync/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('is disabled and relabelled while a sync is running, then re-enabled', async () => {
    let finish!: (v: R[]) => void;
    const spy = syncSpy().mockImplementation(() => new Promise((r) => { finish = r as never; }));
    const card = await openAddData();
    await userEvent.click(card);
    // the top-bar sync control also reads "Syncing…", so find the card by its title div
    const running = () => screen.getByText('Syncing…', { selector: 'div' }).closest('button') as HTMLButtonElement;
    await waitFor(() => expect(running().disabled).toBe(true));
    await userEvent.click(running()); // disabled: no second call
    expect(spy).toHaveBeenCalledTimes(1);
    finish([res('item-a', 1)]);
    await waitFor(() => expect(screen.getByText('Sync done — 1 new transaction')).toBeTruthy());
    expect((screen.getByRole('button', { name: /Force sync/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the s key starts a sync, and a second press while it runs is ignored', async () => {
    localStorage.setItem('fungible-keys', 'on');
    let finish!: (v: R[]) => void;
    const spy = syncSpy().mockImplementation(() => new Promise((r) => { finish = r as never; }));
    renderScreen(<Accounts />);
    await screen.findByText('Test Checking');
    await userEvent.keyboard('s');
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await userEvent.keyboard('s');
    await userEvent.keyboard('s');
    expect(spy).toHaveBeenCalledTimes(1);
    finish([res('item-a', 3)]);
    await waitFor(() => expect(screen.getByText('Sync done — 3 new transactions')).toBeTruthy());
    expect(spy.mock.calls[0]).toEqual([true]);
  });
});
