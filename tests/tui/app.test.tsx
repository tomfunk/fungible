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
import { waitFor, frame } from '../helpers/waitFor.js';
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

  it('pressing 2 switches to Transactions screen', async () => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('Dashboard'));
    r.stdin.write('2');
    await waitFor(() => expect(frame(r)).toContain('Transactions'));
  });

  it('pressing 1 from Transactions returns to Dashboard', async () => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('Dashboard'));
    r.stdin.write('2');
    await waitFor(() => expect(frame(r)).toContain('Transactions'));
    r.stdin.write('1');
    await waitFor(() => expect(frame(r)).toContain('Dashboard'));
  });

  it('h key toggles hint text', async () => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('fungible'));
    // hints off by default — pressing h shows them
    r.stdin.write('h');
    await waitFor(() => expect(frame(r)).toContain('[h]'));
  });

  it('pressing 0 switches to Settings screen', async () => {
    const r = render(<App />);
    await waitFor(() => expect(frame(r)).toContain('Dashboard'));
    r.stdin.write('0');
    await waitFor(() => expect(frame(r)).toContain('Settings'));
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
    for (const [digit, markers] of sweep) {
      r.stdin.write(digit);
      await waitFor(() => {
        const f = frame(r);
        for (const m of markers) expect(f).toContain(m);
      }, 2000);
    }
  });
});
