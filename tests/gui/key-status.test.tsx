// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Mirrors tests/key-health.test.ts's approach: stub the key file and decrypt
// outcome directly rather than touching the real filesystem.
const cryptoMock = vi.hoisted(() => ({
  keyFileExists: vi.fn(() => true),
  decryptToken: vi.fn((t: string) => t),
}));
vi.mock('../../core/crypto.js', () => cryptoMock);

import { db } from '../../core/db.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';
import { KeyStatusProvider, useKeyStatus } from '../../gui/renderer/src/hooks/useKeyStatus.js';

async function addLinkedAccount(accountId: string, itemId: string, accessToken = 'enc(tok)') {
  await db.execute({
    sql: `INSERT OR IGNORE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`,
    args: [itemId, accessToken, 'Chase'],
  });
  await db.execute({
    sql: `INSERT INTO accounts (id, name, type, item_id) VALUES (?, ?, 'depository', ?)`,
    args: [accountId, 'Checking', itemId],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  cryptoMock.keyFileExists.mockReturnValue(true);
  cryptoMock.decryptToken.mockImplementation((t: string) => t);
  for (const tbl of ['accounts', 'plaid_items']) await db.execute(`DELETE FROM ${tbl}`);
  installBridge();
});

afterEach(() => cleanup());

function Probe() {
  const health = useKeyStatus();
  return <div data-testid="probe">{JSON.stringify(health)}</div>;
}

describe('useKeyStatus / KeyStatusProvider', () => {
  it('defaults to ok before the pull resolves, then reflects the result', async () => {
    await addLinkedAccount('acct-1', 'item-1');
    cryptoMock.keyFileExists.mockReturnValue(false);

    renderScreen(
      <KeyStatusProvider>
        <Probe />
      </KeyStatusProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe(
        JSON.stringify({ ok: false, reason: 'missing_key', linkedAccountCount: 1 }),
      ),
    );
  });

  it('stays ok with no linked accounts', async () => {
    renderScreen(
      <KeyStatusProvider>
        <Probe />
      </KeyStatusProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(JSON.stringify({ ok: true })));
  });
});

describe('GUI Accounts — key health banner', () => {
  it('shows nothing when the key is healthy', async () => {
    await addLinkedAccount('acct-1', 'item-1');
    renderScreen(
      <KeyStatusProvider>
        <Accounts />
      </KeyStatusProvider>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
    expect(screen.queryByText(/Encryption key/)).toBeNull();
  });

  it('warns about a missing key, naming the affected account count', async () => {
    await addLinkedAccount('acct-1', 'item-1');
    cryptoMock.keyFileExists.mockReturnValue(false);

    renderScreen(
      <KeyStatusProvider>
        <Accounts />
      </KeyStatusProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Encryption key missing — 1 linked account can't sync until it's restored\./),
      ).toBeTruthy(),
    );
  });

  it('warns about a mismatched key with plural account count', async () => {
    await addLinkedAccount('acct-1', 'item-1');
    await addLinkedAccount('acct-2', 'item-1', 'enc(tok2)');
    cryptoMock.decryptToken.mockImplementation(() => {
      throw new Error('Unsupported state or unable to authenticate data');
    });

    renderScreen(
      <KeyStatusProvider>
        <Accounts />
      </KeyStatusProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          /Encryption key doesn't match this database — 2 linked accounts may need re-linking\./,
        ),
      ).toBeTruthy(),
    );
  });

  it('does not check key health at all without a provider (default context)', async () => {
    await addLinkedAccount('acct-1', 'item-1');
    cryptoMock.keyFileExists.mockReturnValue(false);

    // No KeyStatusProvider — the hook falls back to its default `{ ok: true }`
    // context value, so no bridge call happens and no banner renders.
    renderScreen(<Accounts />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
    expect(screen.queryByText(/Encryption key/)).toBeNull();
  });
});
