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

import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Health } from '../../tui/Health.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts } from '../../tui/Accounts.js';
import { Canvas } from '../../tui/Canvas.js';
import { Settings } from '../../tui/Settings.js';
import { waitFor, frame, press } from '../helpers/waitFor.js';
import { SCREEN_NAV } from '../helpers/screenNav.js';
import { W, MAY_FILTER, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

type Navigate = (s: string, ...rest: unknown[]) => void;

interface Entry {
  screen: string;
  /** A datum unique to this screen that only appears once its data has loaded. */
  datum: string;
  mount: (onNavigate: Navigate) => React.ReactElement;
}

// Every screen mounted directly (the real App adds nothing to the nav path), so
// the contract "digit N navigates to screen X, a screen's own digit is a no-op"
// is pinned per screen against the shared SCREEN_NAV table.
const MOUNTS: Entry[] = [
  { screen: 'settings', datum: 'HOUSEHOLD',
    mount: (n) => <Settings onNavigate={n} showHints={false} /> },
  { screen: 'dashboard', datum: 'SPENDING BY CATEGORY',
    mount: (n) => <Dashboard onNavigate={n} showHints={false} initialFilter={MAY_FILTER} /> },
  { screen: 'transactions', datum: 'Trader Joes',
    mount: (n) => <Transactions onNavigate={n} showHints={false} initialFilter={{ from: '2026-05-01', to: '2026-05-31' }} /> },
  { screen: 'trends', datum: 'avg/month',
    mount: (n) => <Trends onNavigate={n} showHints={false} initialFilter={MAY_FILTER} /> },
  { screen: 'networth', datum: 'Total assets',
    mount: (n) => <NetWorth onNavigate={n} showHints={false} /> },
  { screen: 'tags', datum: 'travel',
    mount: (n) => <Tags onNavigate={n} showHints={false} /> },
  { screen: 'health', datum: 'SNAPSHOT',
    mount: (n) => <Health onNavigate={n} showHints={false} /> },
  { screen: 'rules', datum: 'Whole Foods',
    mount: (n) => <Rules onNavigate={n} showHints={false} /> },
  { screen: 'accounts', datum: 'Test Visa',
    mount: (n) => <Accounts onNavigate={n} showHints={false} /> },
  // Canvas digit keys are only swallowed while a dial/list cell is mid-edit
  // (covered in canvas.test.tsx); at rest they navigate like every other screen.
  { screen: 'canvas', datum: 'Ask the agent',
    mount: (n) => <Canvas onNavigate={n} onLoadSpec={() => {}} showHints={false} spec={null} specKey={0} /> },
];

const entries = SCREEN_NAV.map((nav) => ({
  nav,
  mount: MOUNTS.find((m) => m.screen === nav.screen)!,
}));

describe('screen nav contract', () => {
  it('covers every screen in SCREEN_NAV', () => {
    expect(MOUNTS.map((m) => m.screen).sort()).toEqual(SCREEN_NAV.map((n) => n.screen).sort());
  });

  describe.each(entries)('$nav.screen', ({ nav, mount }) => {
    it('renders title and its own header', async () => {
      const r = render(<W>{mount.mount(vi.fn())}</W>);
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('fungible');
        expect(f).toContain(nav.header);
        expect(f).toContain(mount.datum);
      }, 2000);
    });

    it('digit keys navigate to every other screen and ignore its own', async () => {
      const onNavigate = vi.fn();
      const r = render(<W>{mount.mount(onNavigate)}</W>);
      await waitFor(() => expect(frame(r)).toContain(mount.datum), 2000);

      for (const other of SCREEN_NAV.filter((n) => n.screen !== nav.screen)) {
        const before = onNavigate.mock.calls.length;
        await press(r, other.digit);
        expect(onNavigate.mock.calls.length, `digit ${other.digit}`).toBe(before + 1);
        // Trends passes (screen, undefined); only the first argument is the contract.
        expect(onNavigate.mock.calls.at(-1)![0], `digit ${other.digit}`).toBe(other.screen);
      }

      const total = onNavigate.mock.calls.length;
      expect(total).toBe(SCREEN_NAV.length - 1);
      await press(r, nav.digit);
      expect(onNavigate.mock.calls.length).toBe(total);
    });
  });
});
