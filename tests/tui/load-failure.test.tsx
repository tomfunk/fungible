import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Health } from '../../tui/Health.js';
import { Accounts } from '../../tui/Accounts.js';
import { waitFor as baseWaitFor, flatFrame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { failDb, captureUnhandled } from '../helpers/failingDb.js';
import { W, MAY_FILTER, noop, useEmptyScreenDb } from './helpers/screenSetup.js';

useEmptyScreenDb();

type ScreenProps = { onNavigate: () => void; showHints: boolean };
const CASES: Array<[string, React.ComponentType<ScreenProps>, string[]]> = [
  ['Dashboard', (p) => <Dashboard {...p} initialFilter={MAY_FILTER} />, ['No expense data for this period.']],
  ['Transactions', (p) => <Transactions {...p} />, ['0 transactions']],
  ['Trends', (p) => <Trends {...p} />, ['No data.']],
  ['NetWorth', (p) => <NetWorth {...p} />, ['No balance data yet.']],
  ['Tags', (p) => <Tags {...p} />, ['No tags yet.', '0 tags']],
  ['Rules', (p) => <Rules {...p} />, ['No rules yet.', '0 rules']],
  ['Health', (p) => <Health {...p} />, ['no income found in transactions']],
  ['Accounts', (p) => <Accounts {...p} />, ['No accounts linked yet.']],
];

/*
 * BUG (pinned with it.fails, product code untouched): every screen loads with
 * `void query().then(setX)` and no .catch, so when the database rejects the load
 * becomes an unhandled promise rejection (which kills the process under Node's default
 * --unhandled-rejections=throw), or the screen masks the failure as its empty state
 * ("No tags yet.") or sits on "Loading..." forever. The contract asserted below is
 * copy-agnostic about the eventual error text: no unhandled rejection, no empty-state
 * copy (that would tell the user their data is gone), and not a bare "Loading...".
 * Flipping `.fails` to a plain `it` is the job of the PR that fixes the screens.
 */
describe('a rejected load must be surfaced, not swallowed', () => {
  it.fails.each(CASES)('%s', async (name, C, emptyCopy) => {
    const unhandled = captureUnhandled();
    const restore = failDb(db, 'boom');
    try {
      const r = render(<W><C onNavigate={noop} showHints={false} /></W>);
      // Give the rejected load time to either surface as an unhandled rejection or settle into a frame.
      await waitFor(() => expect(unhandled.seen.length).toBeGreaterThan(0), { timeout: 400 }).catch(() => {});
      await new Promise((res) => setTimeout(res, 100));
      const f = flatFrame(r);
      expect(unhandled.seen.length).toBe(0);
      for (const c of emptyCopy) expect(f).not.toContain(c);
      expect(f.trim()).not.toBe('Loading...');
    } finally {
      restore();
      unhandled.stop();
    }
  });
});
