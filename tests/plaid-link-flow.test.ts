import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../core/plaid.js', () => ({
  createLinkToken: vi.fn().mockResolvedValue('link-tok'),
  exchangePublicToken: vi.fn().mockResolvedValue({ accessToken: 'access-new', itemId: 'item-new' }),
}));

vi.mock('../core/crypto.js', () => ({
  encryptToken: (t: string) => `enc(${t})`,
  decryptToken: (t: string) => t.replace(/^enc\((.*)\)$/, '$1'),
}));

import { db } from '../core/db.js';
import { createLinkToken, exchangePublicToken } from '../core/plaid.js';
import { completeLink, createFlowLinkToken } from '../core/plaid-link-flow.js';

const CALLBACK_BODY = JSON.stringify({
  public_token: 'public-abc',
  institution: { name: 'Tartan Bank' },
});

async function itemRow(itemId: string) {
  const res = await db.execute({ sql: 'SELECT * FROM plaid_items WHERE item_id = ?', args: [itemId] });
  return res.rows[0] as unknown as
    { item_id: string; access_token: string; institution_name: string | null; days_requested: number | null } | undefined;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.execute('DELETE FROM plaid_items');
});

describe('createFlowLinkToken', () => {
  it('sends no access token when adding a bank', async () => {
    await createFlowLinkToken({ daysRequested: 365 });
    expect(createLinkToken).toHaveBeenCalledWith('local-user', 365, undefined);
  });

  it('sends the stored access token in update mode, decrypted', async () => {
    await db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)`,
      args: ['item-1', 'enc(access-existing)', 'Tartan Bank', 365],
    });
    await createFlowLinkToken({ updateItemId: 'item-1' });
    expect(createLinkToken).toHaveBeenCalledWith('local-user', undefined, 'access-existing');
  });

  it('refuses to update an item that is not in the database', async () => {
    await expect(createFlowLinkToken({ updateItemId: 'item-missing' })).rejects.toThrow(/item-missing/);
  });
});

describe('completeLink', () => {
  it('exchanges and stores the item when adding a bank', async () => {
    const result = await completeLink(CALLBACK_BODY, { daysRequested: 365 });

    expect(exchangePublicToken).toHaveBeenCalledWith('public-abc');
    expect(result).toEqual({ itemId: 'item-new', institutionName: 'Tartan Bank', updateMode: false });
    expect(await itemRow('item-new')).toMatchObject({
      access_token: 'enc(access-new)',
      institution_name: 'Tartan Bank',
      days_requested: 365,
    });
  });

  it('does not exchange the public token in update mode', async () => {
    await db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)`,
      args: ['item-1', 'enc(access-existing)', 'Tartan Bank', 365],
    });

    const result = await completeLink(CALLBACK_BODY, { updateItemId: 'item-1' });

    expect(exchangePublicToken).not.toHaveBeenCalled();
    expect(result).toEqual({ itemId: 'item-1', institutionName: 'Tartan Bank', updateMode: true });
  });

  // An update carries no days_requested (update mode forbids it), so writing the
  // row would blank the history window stored when the Item was created.
  it('leaves the existing item row untouched in update mode', async () => {
    await db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)`,
      args: ['item-1', 'enc(access-existing)', 'Tartan Bank', 365],
    });

    await completeLink(CALLBACK_BODY, { updateItemId: 'item-1' });

    expect(await itemRow('item-1')).toMatchObject({
      access_token: 'enc(access-existing)',
      days_requested: 365,
    });
  });

  // The whole point of update mode: updating a link must not leave a second Item
  // behind, because a new Item means new account and transaction ids.
  it('adds no second item row in update mode', async () => {
    await db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)`,
      args: ['item-1', 'enc(access-existing)', 'Tartan Bank', 365],
    });

    await completeLink(CALLBACK_BODY, { updateItemId: 'item-1' });

    const all = await db.execute('SELECT item_id FROM plaid_items');
    expect(all.rows.map((r) => (r as unknown as { item_id: string }).item_id)).toEqual(['item-1']);
  });
});
