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
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';

/**
 * Overrides bridge calls for one test and records what each was called with.
 *
 * Three of these matter here. plaid.linkBank drives the whole feature and its
 * default harness stub throws; its recorded arguments are the point, since
 * passing days or omitting the item id is exactly the bug this fixed —
 * /link/token/create without an access_token mints a new Item rather than
 * re-authorizing the existing one. plaid.isConfigured must be true or the
 * add-a-bank card renders disabled. And sync.syncAll is left pending on
 * purpose: a successful update fires it, and letting it settle would overwrite
 * the "Updated …" toast with the sync's own message before it could be read.
 */
function stubBridge(overrides: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Record<string, unknown[][]> = {};
  const bridge = window.__bridge as unknown as {
    call: (ns: string, fn: string, args: unknown[]) => Promise<unknown>;
  };
  const inner = bridge.call.bind(bridge);
  bridge.call = async (ns, fn, args) => {
    const key = `${ns}.${fn}`;
    if (key in overrides) {
      (calls[key] ??= []).push(args);
      return overrides[key](...args);
    }
    return inner(ns, fn, args);
  };
  return {
    callsTo: (key: string) => calls[key] ?? [],
  };
}

/** The common stub set: Plaid configured, linkBank succeeding, sync left
 *  pending so the post-update toast stays readable. */
const linkBankStubs = (
  linkBank: (...args: unknown[]) => unknown = async () => ({ institutionName: 'Chase' }),
) => stubBridge({
  'plaid.linkBank': linkBank,
  'plaid.isConfigured': async () => true,
  'sync.syncAll': () => new Promise(() => {}),
});

const addItem = (itemId: string, institution: string | null, daysRequested: number | null = null) =>
  db.execute({
    sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested)
          VALUES (?, ?, ?, ?, ?)`,
    args: [itemId, 'tok', institution, Date.now(), daysRequested],
  });

const addAccount = (id: string, itemId: string) =>
  db.execute({
    sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
    args: [id, id, itemId],
  });

/** Renders the screen and opens the Links tab, where the action lives. */
async function links() {
  renderScreen(<Accounts />);
  await userEvent.click(await screen.findByRole('button', { name: /^Links/ }));
}

/** The common case: one connection, sitting on the Links tab. */
async function openUpdateModal(daysRequested: number | null = null) {
  await addItem('item-a', 'Chase', daysRequested);
  await addAccount('acct-1', 'item-a');
  await links();
  await userEvent.click(await screen.findByRole('button', { name: 'update link' }));
  await waitFor(() => expect(screen.getByText('Update link')).toBeTruthy());
}

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts',
                     'balance_history', 'sync_state', 'plaid_items']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  installBridge();
});

afterEach(() => cleanup());

describe('GUI Accounts — update link', () => {
  it('offers "update link" on a connection row, not "repair"', async () => {
    await addItem('item-a', 'Chase');
    await addAccount('acct-1', 'item-a');
    await links();

    await waitFor(() => expect(screen.getByRole('button', { name: 'update link' })).toBeTruthy());
    // The old name described the ordinary add-a-bank flow this replaced.
    expect(screen.queryByRole('button', { name: 'repair' })).toBeNull();
  });

  it('names the connection being updated', async () => {
    await openUpdateModal();
    expect(screen.getByText(/keeping its accounts and transactions/)).toBeTruthy();
    // Scoped to the modal's own emphasis: the row behind it also says "Chase".
    expect(screen.getByText('Chase', { selector: 'strong' })).toBeTruthy();
  });

  // The window is fixed when the item is created and update mode cannot widen
  // it, so offering the field would promise something Plaid rejects.
  it('does not offer the history-window field', async () => {
    await openUpdateModal(730);
    expect(screen.queryByText('History (days)')).toBeNull();
  });

  it('names the history window it is leaving alone', async () => {
    await openUpdateModal(730);
    expect(screen.getByText(/history window stays at 730 days/)).toBeTruthy();
  });

  it('says the window keeps its default when none was recorded', async () => {
    await openUpdateModal();
    expect(screen.getByText(/history window stays at its default/)).toBeTruthy();
  });

  // The whole point of the feature: an update must carry the item id so Plaid
  // re-authorizes this Item, and must not send a history window, which update
  // mode forbids.
  it('sends the item id and no history window', async () => {
    const b = linkBankStubs();
    await openUpdateModal(730);

    await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

    await waitFor(() => expect(b.callsTo('plaid.linkBank')).toHaveLength(1));
    expect(b.callsTo('plaid.linkBank')[0]).toEqual([undefined, 'item-a']);
  });

  it('reports the update, closes the modal, and resyncs the connection', async () => {
    const b = linkBankStubs();
    await openUpdateModal();

    await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

    await waitFor(() => expect(screen.getByText(/Updated Chase/)).toBeTruthy());
    expect(screen.queryByText('Update link')).toBeNull();
    // The resync is what clears the badge: the item's last recorded sync is the
    // failure that sent the user here, and nothing else refreshes that state.
    expect(b.callsTo('sync.syncAll')).toHaveLength(1);
  });

  // Update mode's callback skips the public-token exchange, so Plaid need not
  // hand back an institution name — the row already knows it.
  it('falls back to the stored institution name when Plaid returns none', async () => {
    linkBankStubs(async () => ({ institutionName: null }));
    await openUpdateModal();

    await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

    await waitFor(() => expect(screen.getByText(/Updated Chase/)).toBeTruthy());
  });

  // The generic wording is only reachable for a non-Error rejection: an Error's
  // own message wins, even an empty one. Thrown as a bare string here for that
  // reason, not because the real flow is expected to.
  it('reports a failed update as an update, not a failed link', async () => {
    linkBankStubs(async () => {
      throw 'no Error instance';
    });
    await openUpdateModal();

    await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

    await waitFor(() => expect(screen.getByText('Update failed')).toBeTruthy());
    expect(screen.queryByText('Link failed')).toBeNull();
  });

  it('surfaces the reason when Plaid gives one', async () => {
    linkBankStubs(async () => {
      throw new Error('INSTITUTION_DOWN');
    });
    await openUpdateModal();

    await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

    await waitFor(() => expect(screen.getByText('INSTITUTION_DOWN')).toBeTruthy());
  });

  it('Cancel closes without touching Plaid', async () => {
    const b = linkBankStubs();
    await openUpdateModal();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Update link')).toBeNull());
    expect(b.callsTo('plaid.linkBank')).toHaveLength(0);
  });

  // The modal is shared with the add-a-bank flow, so update mode's changes have
  // to leave that path alone: it still asks for a window and sends no item id.
  describe('the add-a-bank path it shares a modal with', () => {
    it('still offers the history-window field', async () => {
      linkBankStubs();
      renderScreen(<Accounts />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
      await userEvent.click(await screen.findByText('Link a bank'));

      await waitFor(() => expect(screen.getByText('History (days)')).toBeTruthy());
      expect(screen.queryByText(/keeping its accounts and transactions/)).toBeNull();
    });

    it('still sends a history window and no item id', async () => {
      const b = linkBankStubs();
      renderScreen(<Accounts />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
      await userEvent.click(await screen.findByText('Link a bank'));
      await waitFor(() => expect(screen.getByText('History (days)')).toBeTruthy());

      // Prefilled from getDefaultDaysRequested — typing without clearing would
      // append and then truncate straight back to the default.
      const input = screen.getByText('History (days)').closest('div')!.querySelector('input')!;
      await userEvent.clear(input);
      await userEvent.type(input, '365');
      await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

      await waitFor(() => expect(b.callsTo('plaid.linkBank')).toHaveLength(1));
      expect(b.callsTo('plaid.linkBank')[0]).toEqual([365, undefined]);
    });

    it('still rejects a window outside Plaid\'s range', async () => {
      const b = linkBankStubs();
      renderScreen(<Accounts />);
      await userEvent.click(await screen.findByRole('button', { name: 'Add Data' }));
      await userEvent.click(await screen.findByText('Link a bank'));
      await waitFor(() => expect(screen.getByText('History (days)')).toBeTruthy());

      const input = screen.getByText('History (days)').closest('div')!.querySelector('input')!;
      await userEvent.clear(input);
      await userEvent.type(input, '20');
      await userEvent.click(screen.getByRole('button', { name: 'Open Plaid in browser' }));

      await waitFor(() => expect(screen.getByText(/whole number from 30 to 730/)).toBeTruthy());
      expect(b.callsTo('plaid.linkBank')).toHaveLength(0);
    });
  });
});
