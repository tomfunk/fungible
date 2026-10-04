import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

// The Canvas screen and App's spec watcher read canvas-spec.json / canvas-history.json
// from the real data dir. Stub them so the suite never sees the developer's own
// canvases: no spec on disk and an empty history, i.e. the Canvas empty state.
vi.mock('../../core/canvas-history.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/canvas-history.js')>();
  return { ...actual, CANVAS_SPEC_PATH: '/nonexistent/fungible-test/canvas-spec.json', loadHistory: vi.fn(() => []) };
});

import { db } from '../../core/db.js';
import { App } from '../../tui/App.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts } from '../../tui/Accounts.js';
import { Health } from '../../tui/Health.js';
import { Settings } from '../../tui/Settings.js';
import { waitFor as baseWaitFor, frame, press } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { SCREEN_NAV } from '../helpers/screenNav.js';
import { useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('App', () => {
  it('mounts and shows the dashboard without crashing', async () => {
    const r = render(<App />);
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('fungible');
      expect(f).toContain('Dashboard');
    });
  });

  // A datum unique to each screen (seeded data, or a section label that only
  // renders once the screen's own load has run) pairs with the header word,
  // since several header words also appear in other screens' body text
  // (e.g. 'Accounts' in the Net Worth import hint).
  const SCREEN_DATUM: Record<string, string> = {
    settings: 'HOUSEHOLD',
    dashboard: 'SPENDING BY CATEGORY',
    // Dashboard hands over its current-month (Oct) filter, so the seeded May
    // rows are out of range here; the empty-list footer is what identifies the list.
    transactions: '0 transactions',
    trends: 'avg/month',
    networth: 'Total assets',
    tags: 'travel',
    health: 'SNAPSHOT',
    rules: 'Whole Foods',
    accounts: 'Test Visa',
    canvas: 'Ask the agent',
  };

  it.each(SCREEN_NAV)('pressing $digit from Dashboard shows $screen', async ({ digit, screen, header }) => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY CATEGORY'));
    await press(r, digit);
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain(header);
      expect(f).toContain(SCREEN_DATUM[screen]);
      // Digit 1 is Dashboard itself (a no-op); every other digit must leave it.
      if (digit !== '1') expect(f).not.toContain('Dashboard');
    }, 10_000);
  });

  it('h toggles the nav hints on and off', async () => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('fungible'));
    // Hints off by default: just the [h] affordance, no per-screen key list.
    expect(frame(r)).toContain('[h]');
    expect(frame(r)).not.toContain('[2] txns');
    await press(r, 'h');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('[2] txns');
      expect(f).toContain('[0] settings');
      expect(f).not.toContain('[h]');
    });
    await press(r, 'h');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('[h]');
      expect(f).not.toContain('[2] txns');
    });
  });

  it('digit-nav sweep: every screen renders in the full app with seeded data', async () => {
    // Bug-bash sweep: unlike the per-screen describes above (which mount each
    // screen directly), this drives the real App through its digit navigation so
    // every screen mounts with the props/context App actually passes it. Each
    // step asserts the screen's header plus a seeded datum — proving its load
    // path ran, not just that it mounted. Dashboard and Transactions anchor to
    // the real current month (no initialFilter from App), which the fixed
    // May-2026 seed can't reach, so give them one transaction dated today.
    const today = new Date().toISOString().slice(0, 10);
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
            VALUES ('tx-sweep-now', 'test-credit', ?, 'Sweep Marker Coffee', 4.50, 'Dining', 0, 0)`,
      args: [today],
    });

    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('Dashboard'));

    const sweep: [digit: string, markers: string[]][] = [
      ['2', ['Transactions', 'Sweep Marker Coffee']],
      ['3', ['Trends', 'May 2026']],
      ['4', ['Net Worth', 'Test Checking']],
      ['5', ['Tags', 'travel']],
      ['6', ['Financial Health', 'SNAPSHOT']],
      ['7', ['Tag Rules', 'Whole Foods']],  // Rules screen: its section tabs + the seeded rule
      ['8', ['Accounts', 'Test Checking']],
      ['9', ['Canvas']],
      ['0', ['Settings', 'HOUSEHOLD']],
      ['1', ['Dashboard', 'Dining']],
    ];
    let previous = 'Dashboard';
    for (const [digit, markers] of sweep) {
      await press(r, digit);
      const left = previous;
      await waitFor(() => {
        const f = frame(r);
        for (const m of markers) expect(f).toContain(m);
        expect(f).not.toContain(left);
      }, 10_000);
      previous = markers[0];
    }
  });
});
