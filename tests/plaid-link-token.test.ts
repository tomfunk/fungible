import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LinkTokenCreateRequest } from 'plaid';

const linkTokenCreate = vi.fn().mockResolvedValue({ data: { link_token: 'link-tok' } });

vi.mock('plaid', async () => {
  const actual = await vi.importActual<typeof import('plaid')>('plaid');
  return { ...actual, PlaidApi: vi.fn().mockImplementation(() => ({ linkTokenCreate })) };
});

import { Products } from 'plaid';
import { createLinkToken } from '../core/plaid.js';

/** The request body handed to Plaid by the most recent createLinkToken call. */
function lastRequest(): LinkTokenCreateRequest {
  return linkTokenCreate.mock.calls.at(-1)![0] as LinkTokenCreateRequest;
}

beforeEach(() => {
  linkTokenCreate.mockClear();
  process.env.PLAID_CLIENT_ID = 'test-client';
  process.env.PLAID_SECRET = 'test-secret';
  process.env.PLAID_ENV = 'sandbox';
});

describe('createLinkToken', () => {
  it('requests the Transactions product when adding a new bank', async () => {
    await createLinkToken('local-user');
    const req = lastRequest();
    expect(req.products).toEqual([Products.Transactions]);
    expect(req.access_token).toBeUndefined();
  });

  it('passes the history window through when adding', async () => {
    await createLinkToken('local-user', 365);
    expect(lastRequest().transactions).toEqual({ days_requested: 365 });
  });

  // The regression this whole change exists to prevent: without access_token,
  // Plaid mints a brand-new Item on every update, giving every account and
  // transaction fresh ids and duplicating the entire history window.
  it('switches to update mode when given an access token', async () => {
    await createLinkToken('local-user', undefined, 'access-abc');
    expect(lastRequest().access_token).toBe('access-abc');
  });

  // Plaid rejects (or silently mis-handles) a product-specific parameter in
  // update mode, and the TUI passes its default day count on update regardless,
  // so the omission has to survive both arguments being present at once.
  it('omits products and days_requested in update mode even if days are supplied', async () => {
    await createLinkToken('local-user', 365, 'access-abc');
    const req = lastRequest();
    expect(req.products).toBeUndefined();
    expect(req.transactions).toBeUndefined();
    expect(req.access_token).toBe('access-abc');
  });

  // Without this, "update link" can only re-type a password. An Item that has
  // lost its accounts (Plaid's NO_ACCOUNTS) then fails identically after every
  // press, because nothing in the flow ever re-opens the account picker — and at
  // a non-OAuth institution the picker only appears when we ask for it.
  it('enables Account Select in update mode so a link with no accounts can be repaired', async () => {
    await createLinkToken('local-user', undefined, 'access-abc');
    expect(lastRequest().update).toEqual({ account_selection_enabled: true });
  });

  it('does not send update options when adding a new bank', async () => {
    await createLinkToken('local-user');
    expect(lastRequest().update).toBeUndefined();
  });
});
