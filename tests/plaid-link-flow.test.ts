import vm from 'node:vm';
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
import { completeLink, createFlowLinkToken, linkPage, oauthReturnPage } from '../core/plaid-link-flow.js';

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
    expect(createLinkToken).toHaveBeenCalledWith('local-user', 365, undefined, undefined);
  });

  it('sends the stored access token in update mode, decrypted', async () => {
    await db.execute({
      sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)`,
      args: ['item-1', 'enc(access-existing)', 'Tartan Bank', 365],
    });
    await createFlowLinkToken({ updateItemId: 'item-1' });
    expect(createLinkToken).toHaveBeenCalledWith('local-user', undefined, 'access-existing', undefined);
  });

  it('forwards the redirect URI', async () => {
    await createFlowLinkToken({ daysRequested: 365, redirectUri: 'https://localhost:4747/oauth-return' });
    expect(createLinkToken).toHaveBeenCalledWith('local-user', 365, undefined, 'https://localhost:4747/oauth-return');
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

/**
 * Runs a page's inline Link script against a stand-in Plaid and DOM, so the tests
 * exercise what the browser would do rather than what the source text contains.
 */
function runPage(html: string, href = 'http://localhost:4747/') {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const el = () => ({ textContent: '', className: '', disabled: false, listeners: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; } });
  const btn = el();
  const status = el();
  const created: Record<string, any>[] = [];
  let opened = 0;
  const location = { href };
  const context = {
    document: { getElementById: (id: string) => (id === 'connect-btn' ? btn : status) },
    Plaid: { create: (cfg: Record<string, any>) => { created.push(cfg); return { open: () => { opened++; } }; } },
    window: { location },
    location,
    fetch: async () => ({ ok: true, text: async () => '' }),
  };
  vm.runInNewContext(script, context);
  return { btn, status, created, opened: () => opened, location };
}

describe('link pages', () => {
  it('the Link page opens Link on click, without an OAuth return', () => {
    const page = runPage(linkPage('link-tok'));
    expect(page.opened()).toBe(0);
    page.btn.listeners.click();
    expect(page.opened()).toBe(1);
    expect(page.created[0].token).toBe('link-tok');
    expect(page.created[0]).not.toHaveProperty('receivedRedirectUri');
  });

  // Plaid requires the same link token plus the full URL the bank returned to.
  it('the OAuth return page resumes Link at once with the same token and the returned URL', () => {
    const href = 'https://localhost:4747/oauth-return?oauth_state_id=abc';
    const page = runPage(oauthReturnPage('link-tok'), href);
    expect(page.opened()).toBe(1);
    expect(page.created[0].token).toBe('link-tok');
    expect(page.created[0].receivedRedirectUri).toBe(href);
  });

  // An oauth_state_id can only be used once, so after an exit the way forward is
  // a fresh start from the Link page, not re-opening this one.
  it('the OAuth return page offers a way back to the start', () => {
    const page = runPage(oauthReturnPage('link-tok'), 'https://localhost:4747/oauth-return?oauth_state_id=abc');
    page.btn.listeners.click();
    expect(page.location.href).toBe('/');
  });

  it('the OAuth return page completes through the same callback', async () => {
    const page = runPage(oauthReturnPage('link-tok', { updateMode: true }));
    await page.created[0].onSuccess('public-abc', { institution: { name: 'Tartan Bank' } });
    expect(page.status.textContent).toBe('Link updated! You can close this window.');
  });

  // The shared shell must not change what the existing Link page says.
  it('the Link page keeps its title and wording in both modes', () => {
    expect(linkPage('t')).toContain('<title>Fungible — Connect Bank</title>');
    expect(linkPage('t')).toContain('<button id="connect-btn">Connect Bank</button>');
    const update = linkPage('t', { updateMode: true });
    expect(update).toContain('<title>Fungible — Update Link</title>');
    expect(update).toContain('Your existing accounts and transactions are kept.');
    expect(update).toContain('<button id="connect-btn">Update Credentials</button>');
  });

  // The error code is what separates a registration gap (INSTITUTION_REGISTRATION_REQUIRED)
  // from a bug, and the session id is what Plaid's Dashboard logs are searched by.
  it.each([['link page', linkPage('t')], ['return page', oauthReturnPage('t')]])(
    'the %s shows the error code and Link session on exit', (_name, html) => {
      const page = runPage(html);
      if (!page.created.length) page.btn.listeners.click();
      page.created[0].onExit(
        { error_code: 'INSTITUTION_REGISTRATION_REQUIRED', error_message: 'not registered', display_message: null },
        { link_session_id: 'sess-1' },
      );
      expect(page.status.textContent).toBe('not registered (INSTITUTION_REGISTRATION_REQUIRED) Link session: sess-1');
      expect(page.status.className).toBe('status error');
    });

  it('prefers Plaid\'s user-facing message when there is one', () => {
    const page = runPage(linkPage('t'));
    page.btn.listeners.click();
    page.created[0].onExit({ error_code: 'X', error_message: 'dev text', display_message: 'Try again later.' }, {});
    expect(page.status.textContent).toBe('Try again later. (X)');
  });
});
