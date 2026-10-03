import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { App } from '../../tui/App.js';
import { setSyncResult, clearSyncFailures } from '../../core/sync-status.js';


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
    await waitFor(() => expect(frame(r)).toContain('Dashboard')); // screen mounted and settled
    expect(frame(r)).not.toContain('Sync failed');
  });
});
