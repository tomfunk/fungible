import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import * as syncApi from '../../core/sync.js';
import { FilterProvider } from '../../tui/FilterContext.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { W, MAY_FILTER, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('Dashboard', () => {
  afterEach(() => vi.restoreAllMocks());

  function dash(overrides?: Parameters<typeof Dashboard>[0]) {
    return render(
      <W>
        <Dashboard onNavigate={noop} showHints={false} initialFilter={MAY_FILTER} {...overrides} />
      </W>,
    );
  }

  it('renders app title and screen header', () => {
    const r = dash();
    expect(frame(r)).toContain('fungible');
    expect(frame(r)).toContain('Dashboard');
  });

  it('shows Income / Expenses / Net after data loads', async () => {
    const r = dash();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Income');
      expect(f).toContain('Expenses');
      expect(f).toContain('Net');
    });
  });

  it('shows spending amounts from seeded transactions', async () => {
    const r = dash();
    await waitFor(() => {
      const f = frame(r);
      // Grocery ($205) should be the top category
      expect(f).toContain('Grocery');
    });
  });

  it('shows SPENDING BY CATEGORY heading', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY CATEGORY'));
  });

  it('SPENDING BY CATEGORY lines sum to the displayed Expenses total', async () => {
    // Exercise the two cases that used to break reconciliation: a refund inside a
    // real category (must NET to 200, not show 300) and an income+spend mix inside
    // Uncategorized (must SPLIT — the $500 spend shows, the $2000 inflow is income).
    await db.batch([
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel',        'test-credit',   '2026-05-04', 'United',        300.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-travel-refund', 'test-credit',   '2026-05-05', 'United Refund', -100.00, 'Travel', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-uncat-spend',   'test-credit',   '2026-05-07', 'Mystery Shop',  500.00, 'Uncategorized', 0, 0)`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-uncat-income',  'test-checking', '2026-05-02', 'Side Gig',     -2000.00, 'Uncategorized', 0, 0)`,
    ], 'write');

    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Uncategorized'));

    const [statRegion, catRegion] = frame(r).split('SPENDING BY CATEGORY');
    const money = (s: string) =>
      [...s.matchAll(/[-+]?\$[\d,]+\.\d{2}/g)].map((m) => parseFloat(m[0].replace(/[$,+]/g, '')));
    // Stat cards render in order Income · Expenses · Net, so Expenses is the 2nd $ token.
    const expenses = money(statRegion)[1];
    const categoryTotal = money(catRegion).reduce((sum, n) => sum + n, 0);

    expect(expenses).toBeCloseTo(1088.99, 2);          // 388.99 seeded + 200 net Travel + 500 uncat
    expect(categoryTotal).toBeCloseTo(expenses, 2);    // detailed lines reconcile to the total
  });

  it('Tab cycles to flex view', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY FLEXIBILITY'));
  });

  it('Tab Tab cycles to account view', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('account'));
  });

  it('account view shows linked accounts', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
    });
  });

  it('owner view is skipped in the Tab cycle when no account has an owner', async () => {
    // Seeded accounts have no owner, so account → Tab should wrap back to categories.
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\t'); // flex
    r.stdin.write('\t'); // account
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\t'); // would be owner, but skipped → categories
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY CATEGORY'));
    expect(frame(r)).not.toContain('SPENDING BY OWNER');
  });

  it('owner view appears after the account view once an owner is assigned', async () => {
    await db.execute({ sql: "UPDATE accounts SET owner = 'Alex' WHERE id = 'test-checking'", args: [] });
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\t'); // flex
    r.stdin.write('\t'); // account
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\t'); // owner
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('SPENDING BY OWNER');
      expect(f).toContain('Alex');         // the assigned owner
      expect(f).toContain('Unassigned');   // test-credit has no owner
    });
  });

  it('r key cycles the range label', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Month'));
    r.stdin.write('r');
    await waitFor(() => {
      const f = frame(r);
      // Range label should change away from 'Month' heading being bold/active
      // The next range after 'month' is 'week' — look for 'Week' in the period area
      expect(f).toContain('Week');
    });
  });

  it('/ key opens search mode', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('▊'));
  });

  it('m key opens merchant drill and renders merchant names', async () => {
    const r = dash();
    // Wait for categories to load (Grocery is top spend = index 0, cursor starts there)
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('m');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('TOP MERCHANTS');
      expect(f).toContain('Whole Foods');
      expect(f).toContain('Trader Joes');
    });
  });

  it('Esc exits merchant drill back to category view', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('m');
    await waitFor(() => expect(frame(r)).toContain('TOP MERCHANTS'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY CATEGORY'));
  });

  it('left arrow in merchant drill navigates to previous period and refreshes merchants', async () => {
    const r = dash(); // anchored to May 2026
    await waitFor(() => expect(frame(r)).toContain('Grocery'), 2000);
    r.stdin.write('m'); // open drill: May has Whole Foods + Trader Joes
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('TOP MERCHANTS');
      expect(f).toContain('Trader Joes');
    }, 2000);
    r.stdin.write('\x1B[D'); // left arrow → April
    // Drill stays open with April merchants — only Whole Foods in April
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('TOP MERCHANTS');
      expect(f).toContain('Whole Foods');
      expect(f).not.toContain('Trader Joes');
    }, 2000);
  });

  it('r key in merchant drill cycles range and keeps drill open', async () => {
    const r = dash(); // anchored to May 2026, range = month
    await waitFor(() => expect(frame(r)).toContain('Grocery'), 2000);
    r.stdin.write('m');
    await waitFor(() => expect(frame(r)).toContain('TOP MERCHANTS'), 2000);
    r.stdin.write('r'); // r: cycle range month → week, drill stays open
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('TOP MERCHANTS'); // drill still open
      expect(f).toContain('Week');          // range cycled
    }, 2000);
  });

  it('s key toggles scorecard mode label', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('s');
    await waitFor(() => expect(frame(r)).toContain('scorecard'));
  });

  it('pressing a nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('3'); // trends
    expect(onNavigate).toHaveBeenCalledWith('trends');
  });

  // Outbound drill payloads carry the period (range + anchor=from) so the
  // dashboard can restore the same month when Esc reverses the drill. The
  // Transactions-side tests check the return trip; these pin the originating
  // payloads so a regression on the Dashboard side can't pass silently.
  it('category drill outbound payload carries range + anchor', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\r'); // Enter on top category (Grocery)
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01', drillFrom: 'dashboard',
      })),
    );
  });

  it('flex drill outbound payload carries range + anchor', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\t'); // → flex view
    await waitFor(() => expect(frame(r)).toContain('SPENDING BY FLEXIBILITY'));
    r.stdin.write('\r');
    // No selectedAccount → no drillFrom, but range/anchor still travel.
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01',
      })),
    );
  });

  it('account drill outbound payload carries range + anchor', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\t'); // flex
    r.stdin.write('\t'); // account
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01', drillFrom: 'dashboard',
      })),
    );
  });

  it('merchant drill outbound payload carries range + anchor=merchantDrill.from', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('m');
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\r');
    // The merchant drill site uniquely sources `anchor` from merchantDrill.from
    // (the captured drill date) rather than the dashboard's current `from` —
    // both land on '2026-05-01' here, but the variant is exercised.
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({
        from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01',
        search: 'Whole Foods', drillFrom: 'dashboard',
      })),
    );
  });

  it("'2' shortcut outbound payload carries range + anchor", async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <Dashboard onNavigate={onNavigate} showHints={false} initialFilter={MAY_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('2');
    expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({
      from: '2026-05-01', to: '2026-05-31', range: 'month', anchor: '2026-05-01',
    }));
  });

  it('shows period label for the anchored month', async () => {
    const r = dash();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/May 2026/);
    });
  });

  it('S key syncs and shows a toast with the added count', async () => {
    vi.spyOn(syncApi, 'syncAll').mockResolvedValue([
      { itemId: 'item-a', added: 3, modified: 0, removed: 0, dupes: 0, skipped: false },
    ]);
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('S');
    expect(syncApi.syncAll).toHaveBeenCalledWith(true);
    await waitFor(() => expect(frame(r)).toContain('Synced — 3 new'));
  });

  it('S key shows a failure toast when sync rejects', async () => {
    vi.spyOn(syncApi, 'syncAll').mockRejectedValue(new Error('boom'));
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('S');
    await waitFor(() => expect(frame(r)).toContain('Sync failed'));
  });

  // A successful sync must reload what's on screen, not just show a toast —
  // simulate syncAll actually writing a new transaction, the way a real Plaid
  // sync would, and confirm the category breakdown picks it up without any
  // other user action (period/view change).
  it('S key reloads the displayed category summary after sync adds data', async () => {
    vi.spyOn(syncApi, 'syncAll').mockImplementation(async () => {
      await db.execute(
        `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
         VALUES ('tx-synced', 'test-credit', '2026-05-12', 'New From Sync', 77.00, 'Synced Category', 0, 0)`,
      );
      return [{ itemId: 'item-a', added: 1, modified: 0, removed: 0, dupes: 0, skipped: false }];
    });
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    expect(frame(r)).not.toContain('Synced Category');
    r.stdin.write('S');
    await waitFor(() => expect(frame(r)).toContain('Synced Category'));
  });
});
