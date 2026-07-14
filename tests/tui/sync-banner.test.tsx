import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { App } from '../../tui/App.js';
import { setSyncResult, clearSyncFailures } from '../../core/sync-status.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const frame = (r: ReturnType<typeof render>) => (r.lastFrame() ?? '').replace(ANSI_RE, '');

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

afterEach(() => { cleanup(); clearSyncFailures(); });

describe('global sync-failure banner', () => {
  it('shows the failure (from either sync path) on a non-Accounts screen', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, item_id) VALUES ('acct-citi', 'Citi Visa', 'credit', 'item-citi')");
    // Simulate a startup/background sync failure landing in the shared store.
    setSyncResult([{ itemId: 'item-citi', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: 'ITEM_LOGIN_REQUIRED' }]);

    const r = render(<App />); // default screen is the Dashboard
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Sync failed');
      expect(f).toContain('ITEM_LOGIN_REQUIRED');
    });
  });

  it('renders no banner when the store has no failures', async () => {
    const r = render(<App />);
    await new Promise((res) => setTimeout(res, 50)); // let effects settle
    expect(frame(r)).not.toContain('Sync failed');
  });
});
