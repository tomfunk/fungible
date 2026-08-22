import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// tui/Accounts.tsx is the only TUI screen that spawns anything (scripts/link.ts),
// so stubbing spawn lets the link panel be driven without a real subprocess.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { db } from '../../core/db.js';
import * as queries from '../../core/queries.js';
import { useLoadGuard } from '../../tui/useLoadGuard.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { App } from '../../tui/App.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { FilterPanel } from '../../tui/FilterPanel.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts, extractLinkUrl } from '../../tui/Accounts.js';
import * as accountsApi from '../../core/accounts.js';
import * as syncApi from '../../core/sync.js';
import * as dedupApi from '../../core/dedup.js';
import { Health } from '../../tui/Health.js';
import { Settings } from '../../tui/Settings.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { SyncStatusProvider } from '../../tui/SyncStatusContext.js';
import { setSyncResult, clearSyncFailures } from '../../core/sync-status.js';
import { FilterProvider, useFilter } from '../../tui/FilterContext.js';
import type { Filter } from '../../core/filters.js';
import { TypingContext } from '../../tui/TypingContext.js';
import { loadProfile, saveProfile } from '../../core/profile.js';

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Stand-in for the scripts/link.ts child: emit on .stdout/.stderr to drive the panel. */
function fakeLinkProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;

function frame(r: ReturnType<typeof render>): string {
  return (r.lastFrame() ?? '').replace(ANSI_RE, '');
}

/** Whitespace-collapsed frame — rows and panels wrap at 80 columns. */
function flat(r: ReturnType<typeof render>): string {
  return frame(r).replace(/\s+/g, ' ');
}

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

function W({ children }: { children: React.ReactNode }) {
  return (
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        {children}
      </TypingContext.Provider>
    </RefreshProvider>
  );
}

// Anchor all tests to May 2026 so they hit the seeded data regardless of real date.
const MAY_FILTER = { range: 'month' as const, anchor: '2026-05-15' };
const noop = () => {};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.mocked(loadProfile).mockResolvedValue(null); // no household members unless a test sets one
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
});

afterEach(() => cleanup());

// ── Dashboard ─────────────────────────────────────────────────────────────────

describe('Dashboard', () => {
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
});

// ── Transactions ──────────────────────────────────────────────────────────────

describe('Transactions', () => {
  const MAY_DATE_FILTER = { from: '2026-05-01', to: '2026-05-31' };

  function txns(overrides?: Partial<Parameters<typeof Transactions>[0]>) {
    return render(
      <W>
        <Transactions onNavigate={noop} showHints={false} initialFilter={MAY_DATE_FILTER} {...overrides} />
      </W>,
    );
  }

  it('renders Transactions title', () => {
    const r = txns();
    expect(frame(r)).toContain('Transactions');
  });

  it('renders column headers', () => {
    const r = txns();
    const f = frame(r);
    expect(f).toContain('DATE');
    expect(f).toContain('DESCRIPTION');
    expect(f).toContain('AMOUNT');
    expect(f).toContain('CATEGORY');
  });

  it('shows seeded transactions after load', async () => {
    const r = txns();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Whole Foods');
    });
  });

  it('shows transaction count in footer', async () => {
    const r = txns();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/\d+ transactions/);
    });
  });

  it('filters to only May transactions when date filter applied', async () => {
    const r = txns();
    await waitFor(() => {
      const f = frame(r);
      // April-only transaction should not appear
      expect(f).not.toContain('tx-groc-apr');
      // May transactions should appear
      expect(f).toContain('Whole Foods');
    });
  });

  it('/ key enters search mode', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('Esc cancel'));
  });

  it('s key cycles sort order label', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('DATE'));
    // Initial sort is 'date-desc', header shows '↓'
    expect(frame(r)).toContain('↓');
    r.stdin.write('s');
    // After one press → date-asc, shows '↑'
    await waitFor(() => expect(frame(r)).toContain('↑'));
  });

  it('Escape navigates back to dashboard', async () => {
    const onNavigate = vi.fn();
    // No date filter so the first Escape goes straight to onNavigate
    const r = render(
      <W>
        <Transactions onNavigate={onNavigate} showHints={false} />
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Transactions'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard', undefined));
  });

  it('Escape clears an active shared filter before navigating', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider initial={{ categories: ['Grocery'] }}>
          <Transactions onNavigate={onNavigate} showHints={false} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('1 category'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).not.toContain('1 category'));
    expect(onNavigate).not.toHaveBeenCalled();
    r.stdin.write('\x1b');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard', undefined));
  });

  // Pushes filter levels into the shared context on mount, simulating a
  // panel apply and/or a drill-in.
  function PushFilters({ filters }: { filters: Filter[] }) {
    const { setFilter } = useFilter();
    React.useEffect(() => {
      for (const f of filters) setFilter(f);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it('Escape steps back one filter level at a time through history', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <PushFilters filters={[
            { categories: ['Grocery'] },
            { categories: ['Grocery'], accounts: ['test-credit'] },
          ]} />
          <Transactions onNavigate={onNavigate} showHints={false} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('1 account, 1 category'));
    r.stdin.write('\x1b'); // pop drill-in → back to the category-only filter
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('1 category');
      expect(f).not.toContain('1 account');
    });
    r.stdin.write('\x1b'); // pop again → back to no filter
    await waitFor(() => expect(frame(r)).not.toContain('1 category'));
    expect(onNavigate).not.toHaveBeenCalled();
    r.stdin.write('\x1b'); // nothing left → navigate
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard', undefined));
  });

  it('u narrows to Uncategorized while keeping the other filter dimensions', async () => {
    const r = render(
      <W>
        <FilterProvider initial={{ accounts: ['test-credit'] }}>
          <Transactions onNavigate={noop} showHints={false} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('1 account'));
    r.stdin.write('u');
    await waitFor(() => expect(frame(r)).toContain('1 account, 1 category'));
  });

  it('Escape reverses a drill-in in one press: pops the filter and returns to its screen', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <PushFilters filters={[{ categories: ['Grocery'] }]} />
          <Transactions
            onNavigate={onNavigate}
            showHints={false}
            initialFilter={{ ...MAY_DATE_FILTER, drillFrom: 'dashboard' }}
          />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('1 category');
      expect(f).toMatch(/May 2026/);
    });
    r.stdin.write('\x1b');
    // Returns to the dashboard carrying the month we drilled from (anchor =
    // the screen's current period start) so it doesn't snap to the latest month.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard', expect.objectContaining({ anchor: '2026-05-01' })));
    // The drill's filter level was popped, not merely navigated away from
    await waitFor(() => expect(frame(r)).not.toContain('1 category'));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('Escape preserves the dashboard month (range + anchor) when reversing a drill-in', async () => {
    const onNavigate = vi.fn();
    // Simulates a drill from the dashboard while viewing May 2026 in month range.
    const r = render(
      <W>
        <FilterProvider>
          <PushFilters filters={[{ categories: ['Grocery'] }]} />
          <Transactions
            onNavigate={onNavigate}
            showHints={false}
            initialFilter={{ ...MAY_DATE_FILTER, range: 'month', anchor: '2026-05-15', drillFrom: 'dashboard' }}
          />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toMatch(/May 2026/));
    r.stdin.write('\x1b');
    // The month travels back via range + anchor; anchor is the period start the
    // dashboard will land on (snapped to May 1), not the most recent month.
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('dashboard', { range: 'month', anchor: '2026-05-01' }),
    );
  });

  it('Escape after stepping a month forward returns the dashboard to that month', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <FilterProvider>
          <PushFilters filters={[{ categories: ['Grocery'] }]} />
          <Transactions
            onNavigate={onNavigate}
            showHints={false}
            initialFilter={{ from: '2026-04-01', to: '2026-04-30', range: 'month', anchor: '2026-04-15', drillFrom: 'dashboard' }}
          />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toMatch(/Apr 2026/));
    r.stdin.write('\x1B[C'); // → step to May within Transactions
    await waitFor(() => expect(frame(r)).toMatch(/May 2026/));
    r.stdin.write('\x1b');
    // "The month you were looking at" is the one on screen at Esc — May, not April.
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith('dashboard', expect.objectContaining({ anchor: '2026-05-01' })),
    );
  });

  it('shows a filter-summary label when the shared filter is active', async () => {
    const r = render(
      <RefreshProvider>
        <TypingContext.Provider value={() => {}}>
          <FilterProvider initial={{ categories: ['Grocery'] }}>
            <Transactions onNavigate={noop} showHints={false} initialFilter={MAY_DATE_FILTER} />
          </FilterProvider>
        </TypingContext.Provider>
      </RefreshProvider>,
    );
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('1 category');
    });
  });

  it('shows a May 2026 date filter label', async () => {
    const r = txns();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/May 2026/);
    });
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W>
        <Transactions onNavigate={onNavigate} showHints={false} initialFilter={MAY_DATE_FILTER} />
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Transactions'));
    r.stdin.write('4'); // networth
    expect(onNavigate).toHaveBeenCalledWith('networth');
  });

  it('Enter opens the edit panel for the selected transaction', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Name');
      expect(f).toContain('Category');
    });
  });

  it('↓ in edit panel moves to Category, ← → cycles categories', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // edit panel open (toggle arrows unique to panel)
    r.stdin.write('\x1b[B'); // ↓ → move to category field
    await waitFor(() => expect(frame(r)).toContain('(unchanged)')); // name inactive = category active
    const before = frame(r);
    r.stdin.write('\x1b[C'); // → cycle to next category
    await waitFor(() => expect(frame(r)).not.toEqual(before));
  });

  it('Esc in edit panel cancels without saving', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Name'));
    r.stdin.write('\x1b'); // Esc
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Name\n'); // panel gone
      expect(f).toContain('Trader Joes');
    });
  });

  it('typing a name in edit panel and Enter saves the display name', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Name')); // panel open, Name field active
    r.stdin.write('TJ');
    await waitFor(() => expect(frame(r)).toContain('TJ'));
    r.stdin.write('\r'); // save
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('TJ');
      expect(f).not.toContain('Trader Joes');
    });
  });

  it('edit panel shows Pattern and Match type fields', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Pattern');
      expect(f).toContain('Match type');
    });
  });

  it('↓↓ navigates to Pattern field and typing shows match count', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // panel open
    r.stdin.write('\x1b[B'); // name → category
    r.stdin.write('\x1b[B'); // category → pattern
    await waitFor(() => expect(frame(r)).toContain('optional')); // Pattern field active (placeholder)
    for (const ch of 'Trader') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('transactions match'));
  });

  it('↓↓↓ navigates to Match type, ← → toggles to regex', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // panel open
    r.stdin.write('\x1b[B'); // name → category
    r.stdin.write('\x1b[B'); // category → pattern
    r.stdin.write('\x1b[B'); // pattern → type
    await waitFor(() => expect(frame(r)).toContain('(unchanged)')); // name inactive = type field reached
    r.stdin.write('\x1b[C'); // → toggle name → regex
    await waitFor(() => expect(frame(r)).toContain('regex'));
  });

  it('Enter with pattern saves as a category rule', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // panel open
    // Change category to Income (→ cycles Grocery index 2 → Income index 3)
    r.stdin.write('\x1b[B'); // name → category
    await waitFor(() => expect(frame(r)).toContain('(unchanged)'));
    r.stdin.write('\x1b[C'); // cycle Grocery → Income
    // Navigate to Pattern and type a pattern
    r.stdin.write('\x1b[B'); // category → pattern
    await waitFor(() => expect(frame(r)).toContain('optional'));
    for (const ch of 'Trader') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('transactions match'));
    r.stdin.write('\r'); // save as rule
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('optional'); // panel closed
      expect(f).toContain('Saved:');
    });
  });

  // The tag panel titles itself with whatever row the cursor is on, so its
  // applied-tag marks have to track that row too. Under a "lacks" filter the
  // row leaves the list the moment it's tagged and the next one slides into
  // the same index — the marks must re-read for the new row instead of still
  // showing the tag that was just applied to the old one.
  const LACKS_BOTH = { tags: [{ name: 'travel', mode: 'lacks' as const }, { name: 'work', mode: 'lacks' as const }] };

  it('tag panel re-reads the tags when tagging drops the row out of a lacks filter', async () => {
    const r = render(
      <W>
        <FilterProvider initial={LACKS_BOTH}>
          <Transactions onNavigate={noop} showHints={false} initialFilter={MAY_DATE_FILTER} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Trader Joes')); // newest May row
    r.stdin.write('g');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Space/Enter toggle'); // panel open
      expect(f).toContain('○ travel');
    });
    r.stdin.write(' '); // apply 'travel' → the row no longer satisfies the filter
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Trader Joes'); // dropped from the list and the panel title
      expect(f).toContain('Amazon');          // next row slid into the cursor
      expect(f).toContain('○ travel');        // ...and it does not carry the tag
    });
  });

  it('tag panel closes when tagging empties the list', async () => {
    const r = render(
      <W>
        <FilterProvider initial={LACKS_BOTH}>
          <Transactions onNavigate={noop} showHints={false} initialFilter={{ from: '2026-05-14', to: '2026-05-14' }} />
        </FilterProvider>
      </W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('g');
    await waitFor(() => expect(frame(r)).toContain('Space/Enter toggle'));
    r.stdin.write(' '); // the only row leaves the filter
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('0 transactions');
      expect(f).not.toContain('Space/Enter toggle'); // panel gone
    });
    r.stdin.write('/'); // ...and list-mode keys work again rather than typing into the panel
    await waitFor(() => expect(frame(r)).toContain('Esc cancel'));
  });
});

// ── Trends ────────────────────────────────────────────────────────────────────

describe('Trends', () => {
  function trends(overrides?: Partial<Parameters<typeof Trends>[0]>) {
    return render(
      <W>
        <Trends onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders app title and screen header', () => {
    const r = trends();
    expect(frame(r)).toContain('fungible');
    expect(frame(r)).toContain('Trends');
  });

  it('shows the current view label (Expenses by default)', async () => {
    const r = trends();
    // Trends shows only the current view's label in the header, not all tabs at once.
    // The initial view is 'Expenses'.
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
  });

  it('shows range labels', async () => {
    const r = trends();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Month');
    });
  });

  it('r key cycles range label', async () => {
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('Month'));
    r.stdin.write('r');
    await waitFor(() => expect(frame(r)).toContain('Quarter'));
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Trends onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Trends'));
    r.stdin.write('1');
    // Trends passes search (undefined when empty) as second arg
    expect(onNavigate).toHaveBeenCalledWith('dashboard', undefined);
  });

  it('right arrow cycles through the base views in order', async () => {
    const r = trends();
    const viewLabels = ['Expenses', 'Income', 'Net', 'Flexibility', 'Fixed', 'Flexible', 'Discretionary'];
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
    for (let i = 1; i < viewLabels.length; i++) {
      r.stdin.write('\x1B[C');
      await waitFor(() => expect(frame(r)).toContain(viewLabels[i]));
    }
  });

  it('Net view shows expense/income direction headers', async () => {
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
    r.stdin.write('\x1B[C'); // Income
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('\x1B[C'); // Net
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Net');
      expect(f).toContain('expenses');
      expect(f).toContain('income');
    });
  });

  it('Flexibility view shows fixed/flexible/discr column headers', async () => {
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
    for (let i = 0; i < 3; i++) r.stdin.write('\x1B[C'); // Expenses→Income→Net→Flexibility
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Flexibility');
      expect(f).toContain('fixed');
      expect(f).toContain('flexible');
    });
  });

  it('shows both seeded periods and Enter navigates to the selected period', async () => {
    const onNavigate = vi.fn();
    const r = render(<W><Trends onNavigate={onNavigate} showHints={false} /></W>);
    // Both Apr and May periods must appear
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Apr 2026');
      expect(f).toContain('May 2026');
    });
    // Cursor starts on the last period (May); Enter navigates to its transactions
    r.stdin.write('\r');
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('transactions', expect.objectContaining({ from: '2026-05-01' }));
    });
  });

  it('search filter from initialFilter shows indicator in header', async () => {
    const r = trends({ initialFilter: { search: 'Whole Foods' } });
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Whole Foods');
    });
  });

  it('search filters to only periods containing matching transactions', async () => {
    // Amazon only appears in May — April should be hidden
    const r = trends({ initialFilter: { search: 'Amazon' } });
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('May 2026');
      expect(f).not.toContain('Apr 2026');
    });
  });

  it('search that matches both periods shows both', async () => {
    // Whole Foods appears in both April and May
    const r = trends({ initialFilter: { search: 'Whole Foods' } });
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Apr 2026');
      expect(f).toContain('May 2026');
    });
  });

  it('pressing 1 passes active search back to dashboard', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Trends onNavigate={onNavigate} showHints={false} initialFilter={{ search: 'Amazon' }} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Trends'));
    r.stdin.write('1');
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('dashboard', { search: 'Amazon' });
    });
  });

  it('pressing 2 passes active search and period into Transactions', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Trends onNavigate={onNavigate} showHints={false} initialFilter={{ search: 'Amazon' }} /></W>,
    );
    // Wait until filter is applied: Amazon-only May visible, April gone
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('May 2026');
      expect(f).not.toContain('Apr 2026');
    });
    r.stdin.write('2');
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith(
        'transactions',
        expect.objectContaining({ search: 'Amazon', from: '2026-05-01' }),
      );
    });
  });

  it('no-match search shows empty state message', async () => {
    const r = trends({ initialFilter: { search: 'zzznomatch' } });
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('No periods match');
    });
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe('Settings', () => {
  function settings(overrides?: Partial<Parameters<typeof Settings>[0]>) {
    return render(
      <W>
        <Settings onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders Settings heading and section labels', () => {
    const r = settings();
    const f = frame(r);
    expect(f).toContain('Settings');
    expect(f).toContain('HOUSEHOLD');
    expect(f).toContain('SPOUSE');
    expect(f).toContain('CHILDREN');
    expect(f).toContain('Your name');
    expect(f).toContain('Birth year');
  });

  it('Enter on a field opens edit mode showing cursor', async () => {
    const r = settings();
    expect(frame(r)).not.toContain('▊');
    r.stdin.write('\r'); // Enter on "Your name" (cursor starts at row 0)
    await waitFor(() => expect(frame(r)).toContain('▊'));
  });

  it('typing in edit mode accumulates in the buffer', async () => {
    const r = settings();
    r.stdin.write('\r');       // open edit on "Your name"
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Tom');
    await waitFor(() => {
      expect(frame(r)).toContain('Tom');
      expect(frame(r)).toContain('▊');
    });
  });

  it('Enter commits the edit and exits edit mode', async () => {
    const r = settings();
    r.stdin.write('\r');       // open
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    await waitFor(() => expect(frame(r)).toContain('Alice')); // wait for buffer to render
    r.stdin.write('\r');       // commit with fresh closure
    await waitFor(() => {
      expect(frame(r)).toContain('Alice');
      expect(frame(r)).not.toContain('▊');
    });
  });

  it('Esc cancels edit without committing', async () => {
    const r = settings();
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    r.stdin.write('\x1b');    // cancel
    await waitFor(() => {
      expect(frame(r)).not.toContain('Alice');
      expect(frame(r)).not.toContain('▊');
    });
  });

  it('[a] adds spouse fields when no spouse exists', async () => {
    const r = settings();
    expect(frame(r)).not.toContain('Spouse name');
    r.stdin.write('a');       // [a] adds spouse from any cursor position
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
  });

  it('[d] on spouse row removes spouse', async () => {
    const r = settings();
    r.stdin.write('a');                 // add spouse
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('\x1B[B');            // ↓ to row 1 (self-year)
    r.stdin.write('\x1B[B');            // ↓ to row 2 (spouse-name)
    // Wait for re-render to commit cursor position before pressing 'd'
    await waitFor(() => expect(frame(r)).toContain('[d] remove spouse'));
    r.stdin.write('d');                 // remove spouse
    await waitFor(() => expect(frame(r)).not.toContain('Spouse name'));
  });

  it('Esc navigates back to dashboard', async () => {
    const onNavigate = vi.fn();
    const r = render(<W><Settings onNavigate={onNavigate} showHints={false} /></W>);
    r.stdin.write('\x1b');
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('dashboard'));
  });

  it('pressing a nav number calls onNavigate', () => {
    const onNavigate = vi.fn();
    const r = render(<W><Settings onNavigate={onNavigate} showHints={false} /></W>);
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('loaded profile values appear after async init', async () => {
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Thomas', birthYear: 1990 }, children: [] });
    const r = settings();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Thomas');
      expect(f).toContain('1990');
    });
  });

  it('committing a name edit calls saveProfile with the updated value', async () => {
    vi.mocked(saveProfile).mockClear();
    const r = settings();
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('Alice');
    await waitFor(() => expect(frame(r)).toContain('Alice'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).not.toContain('▊'));
    expect(vi.mocked(saveProfile)).toHaveBeenCalledWith(
      expect.objectContaining({ self: expect.objectContaining({ name: 'Alice' }) }),
    );
  });

  it('[a] when spouse exists adds a child row', async () => {
    const r = settings();
    r.stdin.write('a');           // add spouse (no spouse yet)
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('a');           // add child (spouse now exists)
    await waitFor(() => expect(frame(r)).toContain('Child 1'));
  });

  it('[d] on a child row removes it', async () => {
    const r = settings();
    r.stdin.write('a');           // add spouse
    await waitFor(() => expect(frame(r)).toContain('Spouse name'));
    r.stdin.write('a');           // add child → rows: self-name(0) self-year(1) spouse-name(2) spouse-year(3) child-0-name(4)
    await waitFor(() => expect(frame(r)).toContain('Child 1'));
    r.stdin.write('\x1B[B');      // ↓ → row 1
    r.stdin.write('\x1B[B');      // ↓ → row 2
    r.stdin.write('\x1B[B');      // ↓ → row 3
    r.stdin.write('\x1B[B');      // ↓ → row 4 (Child 1 name)
    await waitFor(() => expect(frame(r)).toContain('[d] remove'));
    r.stdin.write('d');
    await waitFor(() => expect(frame(r)).not.toContain('Child 1'));
  });

  it('birth year field rejects out-of-range years', async () => {
    const r = settings();
    r.stdin.write('\x1B[B');      // ↓ to self-year (row 1)
    r.stdin.write('\r');          // open edit
    await waitFor(() => expect(frame(r)).toContain('▊'));
    // Write digits individually — numeric fields check /^\d$/ per keypress
    for (const d of '1800') r.stdin.write(d);
    await waitFor(() => expect(frame(r)).toContain('1800')); // buffer visible while editing
    r.stdin.write('\r');          // commit — rejected because 1800 < 1900
    await waitFor(() => expect(frame(r)).not.toContain('▊'));
    expect(frame(r)).not.toContain('1800');
  });

  it('birth year field accepts years in range', async () => {
    const r = settings();
    r.stdin.write('\x1B[B');      // ↓ to self-year (row 1)
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    for (const d of '1990') r.stdin.write(d);
    await waitFor(() => expect(frame(r)).toContain('1990')); // buffer visible while editing
    r.stdin.write('\r');
    await waitFor(() => {
      expect(frame(r)).toContain('1990');
      expect(frame(r)).not.toContain('▊');
    });
  });
});

// ── Net Worth ─────────────────────────────────────────────────────────────────

describe('NetWorth', () => {
  function networth(overrides?: Partial<Parameters<typeof NetWorth>[0]>) {
    return render(
      <W>
        <NetWorth onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders app title and screen header', () => {
    const r = networth();
    expect(frame(r)).toContain('fungible');
    expect(frame(r)).toContain('Net Worth');
  });

  it('shows seeded accounts after load', async () => {
    const r = networth();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
    });
  });

  it('shows Assets and Liabilities sections', async () => {
    const r = networth();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Assets');
      expect(f).toContain('Liabilities');
    });
  });

  it('Tab cycles to types view', async () => {
    const r = networth();
    await waitFor(() => expect(frame(r)).toContain('Net Worth'));
    r.stdin.write('\t');
    await waitFor(() => {
      const f = frame(r);
      // types view groups by subtype: checking, savings, credit card, brokerage
      expect(f).toContain('checking');
    });
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><NetWorth onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Net Worth'));
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('shows an excluded account in a carved-out section, out of Total assets', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, subtype, excluded) VALUES ('acct-529', 'College 529', 'investment', '529', 1)");
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('acct-529', 12345.00, '2026-05-20')");
    const r = networth();
    await waitFor(() => expect(frame(r)).toContain('Excluded (not in net worth)'));
    const f = frame(r);
    expect(f).toContain('College 529');
    expect(f).toContain('Excluded total');
    // The 529 is an investment asset; were it counted, Total assets would read
    // $17,345.00 (5,000 + 12,345). It must stay out of the headline.
    expect(f).not.toContain('17,345');
  });

  it('omits the excluded section when no account is excluded', async () => {
    const r = networth();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    expect(frame(r)).not.toContain('Excluded (not in net worth)');
  });
});

// ── Tags ──────────────────────────────────────────────────────────────────────

describe('Tags', () => {
  function tags(overrides?: Partial<Parameters<typeof Tags>[0]>) {
    return render(
      <W>
        <Tags onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders app title and screen header', () => {
    const r = tags();
    expect(frame(r)).toContain('fungible');
    expect(frame(r)).toContain('Tags');
  });

  it('shows seeded tags after load', async () => {
    const r = tags();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('travel');
      expect(f).toContain('work');
    });
  });

  it('a key enters new-tag input mode', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Tag'));
  });

  it('[n] opens rename panel pre-filled with the tag name', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Rename Tag');
      expect(f).toContain('travel');
    });
  });

  it('typing a suffix and Enter in rename panel renames the tag', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Rename Tag'));
    for (const ch of '-edited') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('travel-edited'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Rename Tag');
      expect(f).toContain('travel-edited');
    });
  });

  it('Esc in rename panel cancels without saving', async () => {
    const r = tags();
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Rename Tag'));
    for (const ch of 'xyz') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('travelxyz'));
    r.stdin.write('\x1b');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Rename Tag');
      expect(f).not.toContain('travelxyz');
      expect(f).toContain('travel');
    });
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Tags onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Tags'));
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });
});

// ── Rules ─────────────────────────────────────────────────────────────────────

describe('Rules', () => {
  function rules(overrides?: Partial<Parameters<typeof Rules>[0]>) {
    return render(
      <W>
        <Rules onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders app title and section tabs', () => {
    const r = rules();
    const f = frame(r);
    expect(f).toContain('fungible');
    expect(f).toContain('Category Rules');
    expect(f).toContain('Name Rules');
    expect(f).toContain('Categories');
  });

  it('shows seeded category rule after load', async () => {
    const r = rules();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Whole Foods');
    });
  });

  it('Tab cycles to Name Rules section', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    await waitFor(() => {
      // Name Rules section is now active — its label should be highlighted (non-dimmed)
      // We can check we're in name rules by pressing Tab again to get to Categories
      expect(frame(r)).toContain('Name Rules');
    });
  });

  it('Tab cycles to Categories section showing seeded categories', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    r.stdin.write('\t'); // rules → names → tags → categories
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Grocery');
      expect(f).toContain('Dining');
    });
  });

  it('Tab cycles to Tag Rules section', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    r.stdin.write('\t'); // rules → names → tags
    await waitFor(() => expect(frame(r)).toContain('No tag rules yet'));
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Tag Rule');
      expect(f).toContain('Match type');
      expect(f).toContain('transactions match');
    });
  });

  it('[a] opens new category rule form', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods')); // rules loaded
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Category Rule');
      expect(f).toContain('Pattern');
    });
  });

  it('typing pattern and Enter in rule-form saves the rule', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Category Rule'));
    for (const ch of 'Starbucks') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Starbucks'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('New Category Rule');
      expect(f).toContain('Starbucks');
    });
  });

  it('Enter on existing rule opens edit form pre-filled with its pattern', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Edit Category Rule');
      expect(f).toContain('Whole Foods');
    });
  });

  it('Esc from search preserves cursor on the highlighted rule (not the unfiltered top)', async () => {
    // Regression: pressing Esc in search used to reset cursor to its pre-search
    // numeric index, so the highlighted (filtered) rule could differ from what
    // 'x' then deleted. Now the cursor re-anchors to that rule by id.
    await db.execute('DELETE FROM category_rules');
    await db.batch([
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Aaa Coffee', 'Dining')",
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Bbb Diner',  'Dining')",
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Zzz Lounge', 'Dining')",
    ], 'write');

    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Aaa Coffee'));
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('Esc clear')); // search bar visible
    for (const ch of 'Zzz') r.stdin.write(ch);
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Zzz Lounge');
      expect(f).not.toContain('Aaa Coffee'); // filter is active
    });
    r.stdin.write('\x1b');         // Esc clears search
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Aaa Coffee'); // full list back
      // ▶ cursor marker should sit on the Zzz row, not the top.
      const zzzLine = f.split('\n').find((l) => l.includes('Zzz Lounge'))!;
      expect(zzzLine.includes('▶')).toBe(true);
    });
  });

  it('[x] deletes the rule and surfaces the recategorized count in the status', async () => {
    // Self-contained: clear seeded transactions/rules so the count pins to exactly 1.
    // Mirrors the GUI delete test (tests/gui/rules.test.tsx) and locks the singular
    // pluralization of the status message ("1 transaction", not "1 transactions").
    await db.execute('DELETE FROM category_rules');
    await db.execute('DELETE FROM transactions');
    await db.execute(
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
       VALUES ('tx-tj', 'test-credit', '2026-05-15', 'Trader Joes', 50.00, 'Grocery', 0, 0)`,
    );
    await db.execute(
      "INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (10, 'name', 'Trader Joes', 'Grocery')",
    );

    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('x');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/Rule deleted · recategorized 1 transaction\b/); // \b rejects trailing 's'
      expect(f).not.toContain('Trader Joes'); // rule gone from the list
    });
  });

  it('[a] in Name Rules section opens new name rule form', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t'); // switch to Name Rules
    await waitFor(() => expect(frame(r)).toContain('No name rules'));
    r.stdin.write('a');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('New Name Rule');
      expect(f).toContain('Pattern');
      expect(f).toContain('Replace with');
    });
  });

  it('typing pattern + replacement in name-rule-form and Enter saves the rule', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('No name rules'));
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('New Name Rule'));
    for (const ch of 'amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('amazon'));
    for (let i = 0; i < 4; i++) r.stdin.write('\x1b[B'); // navigate to replacement
    // Wait for React to commit the field navigation before typing (avoids stale closure)
    await waitFor(() => expect(frame(r)).toContain('display name'));
    for (const ch of 'Amazon') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Amazon'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('New Name Rule');
      expect(f).toContain('amazon');
      expect(f).toContain('Amazon');
    });
  });

  it('Enter in categories section opens the edit panel', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    r.stdin.write('\t'); // categories section
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Edit: Bills & Utilities');
      expect(f).toContain('Name');
      expect(f).toContain('Flexibility');
    });
  });

  it('Esc in categories edit panel closes without navigating away', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('Bills & Utilities'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Edit: Bills & Utilities'));
    r.stdin.write('\x1b');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Edit: Bills & Utilities');
      expect(f).toContain('Bills & Utilities');
    });
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Rules onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });
});

// ── Accounts ──────────────────────────────────────────────────────────────────

describe('Accounts', () => {
  function accounts(overrides?: Partial<Parameters<typeof Accounts>[0]>) {
    return render(
      <W>
        <Accounts onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  /**
   * Tab from Accounts to a named view, so tests don't hard-code how many tabs
   * sit between them. Asserting on view-specific content matters here: every
   * tab's label is in the header on every view, so waiting for "Add Data" would
   * pass without having navigated anywhere.
   */
  const VIEW_MARKER = {
    links: 'connection',                 // Links panel footer, or its empty state
    'add-data': '[l] Link a bank account',
    dupes: 'duplicate',                  // "No duplicate candidates found." / "Checking for duplicates…"
  } as const;

  async function tabTo(r: ReturnType<typeof render>, view: keyof typeof VIEW_MARKER) {
    const order = ['links', 'add-data', 'dupes'] as const;
    for (let i = 0; i <= order.indexOf(view); i++) {
      r.stdin.write('\t');
      // Consecutive writes coalesce into one chunk, which ink reads as a single
      // Tab — the gap keeps each press its own input event.
      await new Promise((res) => setTimeout(res, 10));
    }
    await waitFor(() => expect(flat(r)).toContain(VIEW_MARKER[view]));
  }

  it('renders app title and Accounts tab', () => {
    const r = accounts();
    const f = frame(r);
    expect(f).toContain('fungible');
    expect(f).toContain('Accounts');
  });

  it('shows seeded accounts after load', async () => {
    const r = accounts();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
      expect(f).toContain('Test Visa');
    });
  });

  it('Tab cycles to Add Data view', async () => {
    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\t');
    await waitFor(() => expect(frame(r)).toContain('Add Data'));
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Accounts onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Accounts'));
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  // Regression guards for the stale-list bug: the mutation DB calls are async, so
  // the list must reload only AFTER the write commits. The handlers must await the
  // write before calling loadAccounts(); otherwise the reload reads pre-mutation
  // data and the list never reflects the change.
  //
  // In-memory libsql applies an un-awaited write before the next read, so the race
  // can't be observed at face value. We reproduce the real-world DB latency by
  // delaying the write ~60ms: with the bug, loadAccounts() reads stale data while
  // the write is still in flight and the list never updates; with the fix, the
  // reload is chained off the write and shows fresh data.
  const WRITE_DELAY = 60;
  function delayWrite<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
    return (...args: A): Promise<R> =>
      new Promise((res) => setTimeout(res, WRITE_DELAY)).then(() => fn(...args));
  }
  afterEach(() => vi.restoreAllMocks());

  it('setting a nickname refreshes the list to show the new nickname', async () => {
    const real = accountsApi.updateAccountNickname;
    vi.spyOn(accountsApi, 'updateAccountNickname').mockImplementation(delayWrite(real));

    const r = accounts();
    // Cursor starts on the first account (depository sorts first = Test Checking).
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('Vacation Fund');     // type the nickname (cursor starts on Nickname field)
    await waitFor(() => expect(frame(r)).toContain('Vacation Fund'));
    r.stdin.write('\r');                // save
    // The list row now shows the nickname in place of the account name. Asserting
    // the original name is gone proves the list reloaded with post-write data (the
    // status toast shows the nickname, not the original name).
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Vacation Fund');
      expect(f).not.toContain('Test Checking');
    });
  });

  it('toggling "exclude from net worth" refreshes the list with the excl marker', async () => {
    const real = accountsApi.updateAccountExcluded;
    vi.spyOn(accountsApi, 'updateAccountExcluded').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                            // open unified edit panel (cursor on Nickname)
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    expect(frame(r)).toContain('Included');         // Net-worth toggle defaults to Included
    // Fields for a depository with no household members: Nickname, Type, Subtype, Net worth.
    r.stdin.write('\x1b[B');                         // ↓ Nickname → Type
    r.stdin.write('\x1b[B');                         // ↓ Type → Subtype
    r.stdin.write('\x1b[B');                         // ↓ Subtype → Net worth
    // Let the field-change commit before toggling: the toggle reads editField from
    // its closure, which is stale if the right-arrow runs in the same input batch.
    await new Promise((res) => setTimeout(res, 60));
    r.stdin.write('\x1b[C');                         // → toggle to Excluded
    await waitFor(() => expect(frame(r)).toContain('Excluded'));
    r.stdin.write('\r');                             // save
    await waitFor(() => expect(frame(r)).toContain('excl')); // ⊘ excl row marker after reload
  });

  it('deleting an account refreshes the list to drop it', async () => {
    const real = accountsApi.deleteAccount;
    vi.spyOn(accountsApi, 'deleteAccount').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Test Checking');
      expect(f).toContain('2 accounts');
    });
    r.stdin.write('x');                 // confirm-delete panel
    await waitFor(() => expect(frame(r)).toContain('this cannot be undone'));
    r.stdin.write('y');                 // confirm
    // The account-count line reflects the reloaded list independently of the
    // "Deleted …" status toast (which still mentions the deleted account name).
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('1 account');
      expect(f).toContain('Test Visa');
    });
  });

  it('surfaces an error and leaves the list unchanged when a write fails', async () => {
    vi.spyOn(accountsApi, 'updateAccountNickname').mockRejectedValue(new Error('db down'));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('Vacation Fund');
    await waitFor(() => expect(frame(r)).toContain('Vacation Fund'));
    r.stdin.write('\r');                 // save → write rejects
    // A failed write must show an error rather than a (false) success, and the
    // account must keep its original name.
    await waitFor(() => expect(frame(r)).toContain('Failed to update'));
    const f = frame(r);
    expect(f).toContain('Test Checking');
    expect(f).not.toContain('Updated Vacation Fund');
  });

  it('setting an owner refreshes the list to show the owner on the account row', async () => {
    // The owner editor cycles over household members, so a profile must supply one.
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Alex Stark', birthYear: 0 }, children: [] });
    const real = accountsApi.updateAccountOwner;
    vi.spyOn(accountsApi, 'updateAccountOwner').mockImplementation(delayWrite(real));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel (Nickname field active)
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('\x1b[B');             // ↓ Nickname → Owner
    await waitFor(() => expect(frame(r)).toContain('Unassigned')); // owner toggle, default Unassigned
    r.stdin.write('\x1b[C');             // → cycle Unassigned → Alex Stark
    await waitFor(() => expect(frame(r)).toContain('← Alex Stark'));
    r.stdin.write('\r');                 // save (separate chunk so it isn't merged)
    // The success toast is "Updated Test Checking" (it doesn't echo the owner), so
    // the owner appearing on the row proves the list reloaded after the write — under
    // the stale-list bug the row would still be ownerless. Whitespace is collapsed
    // first because the owner can wrap across lines in the account row.
    await waitFor(() => {
      const flat = frame(r).replace(/\s+/g, ' ');
      expect(flat).toContain('Alex Stark');
    });
  });

  it('surfaces an error and does not apply the owner when the write fails', async () => {
    vi.mocked(loadProfile).mockResolvedValue({ self: { name: 'Alex Stark', birthYear: 0 }, children: [] });
    vi.spyOn(accountsApi, 'updateAccountOwner').mockRejectedValue(new Error('db down'));

    const r = accounts();
    await waitFor(() => expect(frame(r)).toContain('Test Checking'));
    r.stdin.write('\r');                 // open unified edit panel
    await waitFor(() => expect(frame(r)).toContain('Edit: Test Checking'));
    r.stdin.write('\x1b[B');             // ↓ Nickname → Owner
    await waitFor(() => expect(frame(r)).toContain('Unassigned'));
    r.stdin.write('\x1b[C');             // → cycle to Alex Stark
    await waitFor(() => expect(frame(r)).toContain('← Alex Stark'));
    r.stdin.write('\r');                 // save → write rejects
    await waitFor(() => expect(frame(r)).toContain('Failed to update'));
    expect(frame(r)).not.toContain('Updated Test Checking');
  });

  // The link URL is printed once by scripts/link.ts and then buried by later
  // status lines ("Waiting for you to connect…"), which share the single
  // linkMsg slot. It has to be captured from the chunk and pinned separately —
  // on Linux there is no `open`, so it is the only way into the Plaid flow.
  describe('link URL capture', () => {
    it('extracts the URL from the line link.ts prints', () => {
      expect(extractLinkUrl('Opening http://localhost:4747 …')).toBe('http://localhost:4747');
    });

    it('finds the URL anywhere in a multi-line chunk, not just the last line', () => {
      const chunk = 'Opening http://localhost:4747 …\nWaiting for you to connect in the browser…\n';
      // The last line is what becomes linkMsg, so a last-line-only scan would miss it.
      expect(chunk.trim().split('\n').pop()).not.toContain('localhost');
      expect(extractLinkUrl(chunk)).toBe('http://localhost:4747');
    });

    it('returns null for status lines that carry no URL', () => {
      expect(extractLinkUrl('Saving institution…')).toBeNull();
      expect(extractLinkUrl('Creating Plaid link token…')).toBeNull();
    });

    it('reads whatever port link.ts is using rather than assuming one', () => {
      expect(extractLinkUrl('Opening http://localhost:8080 …')).toBe('http://localhost:8080');
    });

    // The regression the user hit: the URL scrolled away behind the next status
    // line, leaving nothing to click while the ticker counted up.
    it('keeps the URL on screen after later status lines replace the message', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');                                   // → history-window prompt
      await waitFor(() => expect(flat(r)).toContain('days'));
      r.stdin.write('\r');                                  // → starts the link
      await waitFor(() => expect(flat(r)).toContain('Link Bank Account'));

      proc.stdout.emit('data', Buffer.from('Opening http://localhost:4747 …\n'));
      await waitFor(() => expect(flat(r)).toContain('http://localhost:4747'));

      // This line takes over linkMsg — the URL must survive it.
      proc.stdout.emit('data', Buffer.from('Waiting for you to connect in the browser…\n'));
      await waitFor(() => expect(flat(r)).toContain('Waiting for you to connect'));
      expect(flat(r)).toContain('http://localhost:4747');

      // Still there several status lines later.
      proc.stdout.emit('data', Buffer.from('Account link received from Chase — exchanging token…\n'));
      await waitFor(() => expect(flat(r)).toContain('exchanging token'));
      expect(flat(r)).toContain('http://localhost:4747');
    });

    // Same defect shape: the generic exit-code line used to bury the stderr
    // reason, so a crash reported only that it happened, never why.
    it('keeps the stderr reason instead of replacing it with the exit code', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flat(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Link Bank Account'));

      proc.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use 127.0.0.1:4747\n'));
      await waitFor(() => expect(flat(r)).toContain('EADDRINUSE'));
      proc.emit('close', 1);

      await waitFor(() => expect(flat(r)).toContain('Press Enter to return.'));
      expect(flat(r)).toContain('EADDRINUSE');
      expect(flat(r)).not.toContain('Process exited with code 1');
    });

    // The post-link sync runs while the link panel is still on screen. It used
    // to render only linkMsg, so every sync step was invisible and the elapsed
    // counter sat next to the finished link message — indistinguishable from a
    // link that had stalled.
    it('shows sync progress on the link panel after the link completes', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);
      vi.spyOn(syncApi, 'syncAll').mockImplementation(async (_f, _ids, onProgress) => {
        onProgress?.('item-x', { phase: 'transactions', page: 1, fetched: 4321 });
        return new Promise(() => []) as never;
      });
      // A placeholder row, so the close handler finds an item to sync.
      await db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
        args: ['item-x', 'tok', 'Progress Bank'],
      });

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flat(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Link Bank Account'));

      proc.emit('close', 0);
      await waitFor(() => expect(flat(r)).toContain('Bank connected!'));
      // Still on the link panel — the sync step must be visible from here.
      await waitFor(() => expect(flat(r)).toContain('Fetching transactions… 4,321 so far'));
    });

    it('still reports a bare exit code when the child said nothing on stderr', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flat(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Link Bank Account'));

      proc.emit('close', 1);
      await waitFor(() => expect(flat(r)).toContain('Process exited with code 1'));
    });
  });

  // The dupe scan runs detached from loadAccounts so it can't delay the
  // post-link sync. That means the Dupes view can be opened mid-scan, and it
  // must not report a clean result it doesn't have yet.
  describe('dupe scan in flight', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reports the scan as running instead of claiming no duplicates', async () => {
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates').mockImplementation(() => new Promise(() => {}));

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'dupes');
      await waitFor(() => expect(flat(r)).toContain('Checking for duplicates…'));
      expect(flat(r)).not.toContain('No duplicate candidates found.');
    });

    it('reports the clean result once the scan finishes', async () => {
      let finish: (v: never[]) => void = () => {};
      vi.spyOn(dedupApi, 'getCsvPlaidDupeCandidates')
        .mockImplementation(() => new Promise((res) => { finish = res as never; }));

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Test Checking'));
      await tabTo(r, 'dupes');
      await waitFor(() => expect(flat(r)).toContain('Checking for duplicates…'));

      finish([]);
      await waitFor(() => expect(flat(r)).toContain('No duplicate candidates found.'));
    });
  });

  // ── Sync state on the accounts list ───────────────────────────────────────
  //
  // Each case owns the whole list (the seeded accounts are cleared) so a frame
  // assertion is unambiguous about which row it's reading. Frames are whitespace
  // collapsed because a row can wrap at 80 columns.
  describe('sync state', () => {
    beforeEach(async () => {
      await db.execute('DELETE FROM accounts');
      await db.execute('DELETE FROM balance_history');
      await db.execute('DELETE FROM plaid_items');
      clearSyncFailures();
    });
    afterEach(() => clearSyncFailures());

    // The Accounts screen reads failures through SyncStatusProvider; W omits it,
    // so the badge cases need their own wrapper.
    function accountsWithSyncStatus() {
      return render(
        <W>
          <SyncStatusProvider>
            <Accounts onNavigate={noop} showHints={false} />
          </SyncStatusProvider>
        </W>,
      );
    }

    const addItem = (itemId: string, institution: string | null, lastSyncedAt: number | null) =>
      db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
        args: [itemId, 'tok', institution, lastSyncedAt],
      });

    it('renders a placeholder row for a linked but unsynced institution', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = accounts();
      await waitFor(() => {
        const f = flat(r);
        expect(f).toContain('Capital One');
        expect(f).toContain('◷ awaiting first sync');
      });
    });

    // The whole point of the placeholder: a fresh link is never met with
    // "nothing here", which is what nearly caused a duplicate link attempt.
    it('does not show the empty state when only a placeholder exists', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Capital One'));
      expect(flat(r)).not.toContain('No accounts linked yet.');
    });

    it('a failing item outranks the awaiting-first-sync badge', async () => {
      await addItem('item-new', 'Capital One', null);
      setSyncResult([{ itemId: 'item-new', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: 'ITEM_LOGIN_REQUIRED' }]);
      const r = accountsWithSyncStatus();
      await waitFor(() => expect(flat(r)).toContain('⚠ sync failed'));
      // The footer still names the institution as awaiting a first sync — it is.
      // Only the row badge is under test, so match the glyph, not the phrase.
      expect(flat(r)).not.toContain('◷ awaiting first sync');
    });

    it('Enter on a placeholder refuses to open the edit panel and says why', async () => {
      await addItem('item-new', 'Capital One', null);
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('◷ awaiting first sync'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Not synced yet'));
      expect(flat(r)).not.toContain('Edit:');
    });

    it('counts placeholders separately from accounts in the footer', async () => {
      const ts = Date.now();
      await addItem('item-synced', 'Chase', ts);
      await addItem('item-new', 'Capital One', null);
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES ('acct-chase', 'Chase Checking', 'depository', 'checking', 'item-synced')`,
        args: [],
      });
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('1 account · 1 institution awaiting first sync'));
    });

    // Defect 4, end to end: sync writes a balance row only when
    // balances.current is non-null, so this account has no balance_history at
    // all. It used to read "not synced" forever despite its institution syncing
    // fine — it must report the item's sync time instead.
    it('reports the item sync time for a synced account with no balance snapshot', async () => {
      await addItem('item-synced', 'Chase', Date.now() - 5 * 60_000);
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES ('acct-nobal', 'No Balance', 'depository', 'checking', 'item-synced')`,
        args: [],
      });
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('No Balance'));
      expect(flat(r)).toContain('synced 5 min ago');
      expect(flat(r)).not.toContain('not synced');
    });

    // A long sync must show it is still alive. Without this the label is frozen
    // for the whole run and there's no way to tell working from hung — which is
    // what makes people kill the terminal mid-link.
    it('ticks elapsed seconds while a sync is in flight', async () => {
      // Hold syncAll pending so the syncing state persists long enough to observe.
      vi.spyOn(syncApi, 'syncAll').mockImplementation(() => new Promise(() => {}));

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('No accounts linked yet.'));
      r.stdin.write('s');
      await waitFor(() => expect(flat(r)).toContain('Syncing…'));
      // Suppressed below 2s, then counts up.
      await waitFor(() => expect(flat(r)).toMatch(/Syncing…\s+[2-9]\d*s/), 6000);
    });

    // The step name has to actually reach the screen, not just be emitted by
    // core — this is the whole point of threading onProgress into the TUI.
    it('renders the current sync step as the sync reports it', async () => {
      vi.spyOn(syncApi, 'syncAll').mockImplementation(async (_force, _ids, onProgress) => {
        onProgress?.('item-x', { phase: 'transactions', page: 1, fetched: 1234 });
        await new Promise((res) => setTimeout(res, 40));
        onProgress?.('item-x', { phase: 'dedup' });
        return new Promise(() => []) as never;   // stay pending on the last step
      });

      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('No accounts linked yet.'));
      r.stdin.write('s');
      await waitFor(() => expect(flat(r)).toContain('Fetching transactions… 1,234 so far'));
      await waitFor(() => expect(flat(r)).toContain('Checking for duplicates…'));
    });

    // You can't tell two same-named accounts at different banks apart in the
    // edit panel without this. The account row's own institution_name is NULL
    // for everything Plaid links, so the name has to come from the item.
    it('names the institution in the edit panel, inherited from the item', async () => {
      await addItem('item-chase', 'Chase', Date.now());
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, mask, item_id) VALUES ('acct-plaid', 'Plaid Checking', 'depository', 'checking', '0000', 'item-chase')`,
        args: [],
      });
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('Plaid Checking'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Edit: Plaid Checking'));
      expect(flat(r)).toContain('Chase');
    });

    // A manual account has no Plaid item, so its balance-snapshot date is the
    // only sync signal it has — the fallback branch must keep working.
    it('a manual account still renders its balance-snapshot date', async () => {
      await db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype) VALUES ('manual-house', 'House', 'other', null)`,
        args: [],
      });
      await db.execute({
        sql: `INSERT INTO balance_history (account_id, balance, date) VALUES ('manual-house', 500000, '2026-06-12')`,
        args: [],
      });
      const r = accounts();
      await waitFor(() => expect(flat(r)).toContain('House'));
      expect(flat(r)).toContain('synced Jun 12');
    });
  });

  // ── Links tab ──────────────────────────────────────────────────────────────
  // Connection-level view: one row per Plaid item, not per account. The actions
  // that belong to an item (repair now, update mode and replace later) live here
  // rather than on an account row, where they implied a scope they never had.
  describe('links tab', () => {
    beforeEach(async () => {
      await db.execute('DELETE FROM accounts');
      await db.execute('DELETE FROM plaid_items');
      await db.execute('DELETE FROM sync_state');
    });

    const addItem = (itemId: string, institution: string | null, lastSyncedAt: number | null) =>
      db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?, ?, ?, ?)',
        args: [itemId, 'tok', institution, lastSyncedAt],
      });

    const addAccount = (id: string, itemId: string) =>
      db.execute({
        sql: `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, 'depository', 'checking', ?)`,
        args: [id, id, itemId],
      });

    it('lists one row per connection, with its account count', async () => {
      await addItem('item-chase', 'Chase', Date.now());
      await addAccount('acct-1', 'item-chase');
      await addAccount('acct-2', 'item-chase');

      const r = accounts();
      await tabTo(r, 'links');
      const f = flat(r);
      // Two accounts, one row — the whole point of the view.
      expect(f).toContain('Chase');
      expect(f).toContain('2 accounts');
      expect(f).toContain('1 connection');
    });

    it('shows the history window, and names the default when none was recorded', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts();
      await tabTo(r, 'links');
      // days_requested is NULL here, which means Plaid's 90-day default applied.
      expect(flat(r)).toContain('90d (default)');
    });

    it('flags a connection awaiting its first sync', async () => {
      await addItem('item-new', 'Capital One', null);

      const r = accounts();
      await tabTo(r, 'links');
      expect(flat(r)).toContain('awaiting first sync');
    });

    it('flags a connection with no stored cursor as due a full replay', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts();
      await tabTo(r, 'links');
      expect(flat(r)).toContain('full replay pending');
    });

    it('does not flag a replay once a cursor is stored', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');
      await db.execute({ sql: 'INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)', args: ['item-a', 'cur'] });

      const r = accounts();
      await tabTo(r, 'links');
      expect(flat(r)).not.toContain('full replay pending');
    });

    it('[r] opens the link flow from the Links view', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts();
      await tabTo(r, 'links');
      r.stdin.write('r');
      await waitFor(() => expect(flat(r)).toContain('Transaction History Window'));
    });

    it('empty state points at Add Data', async () => {
      const r = accounts();
      await tabTo(r, 'links');
      expect(flat(r)).toContain('No bank connections yet.');
    });

    it('repair is no longer offered from an account row', async () => {
      await addItem('item-a', 'Chase', Date.now());
      await addAccount('acct-1', 'item-a');

      const r = accounts({ showHints: true });
      await waitFor(() => expect(flat(r)).toContain('acct-1'));
      // It moved to the Links tab; the accounts hint must not still advertise it.
      expect(flat(r)).not.toContain('[r] repair link');
    });
  });
});

// ── Health ────────────────────────────────────────────────────────────────────

describe('Health', () => {
  function health(overrides?: Partial<Parameters<typeof Health>[0]>) {
    return render(
      <W>
        <Health onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

  it('renders app title and screen header', () => {
    const r = health();
    const f = frame(r);
    expect(f).toContain('fungible');
    expect(f).toContain('Financial Health');
  });

  it('shows SNAPSHOT section', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('SNAPSHOT'));
  });

  it('shows RUNWAY section', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('RUNWAY'));
  });

  it('shows RETIREMENT section', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('RETIREMENT'));
  });

  it('shows ASSUMPTIONS section', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
  });

  it('pressing nav number calls onNavigate', async () => {
    const onNavigate = vi.fn();
    const r = render(
      <W><Health onNavigate={onNavigate} showHints={false} /></W>,
    );
    await waitFor(() => expect(frame(r)).toContain('Financial Health'));
    r.stdin.write('1');
    expect(onNavigate).toHaveBeenCalledWith('dashboard');
  });

  it('Enter opens dial edit mode showing cursor', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    expect(frame(r)).not.toContain('▊');
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
  });

  it('Esc cancels dial edit mode', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▊'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).not.toContain('▊'));
  });

  it('typing and Enter commit a new dial value', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('\r');         // open edit on spend dial (pre-fills current value)
    await waitFor(() => expect(frame(r)).toContain('▊'));
    // Write digits one at a time — Health's handler uses /^[\d.-]$/ (single-char regex)
    for (const ch of '4000') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('4000'));
    r.stdin.write('\r');         // commit with fresh closure
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('4,000'); // formatted value appears in dial
      expect(f).not.toContain('▊');
    });
  });
});

// ── App smoke test ────────────────────────────────────────────────────────────
// Renders the full component tree (App → screen + Chat) to catch startup crashes
// that screen-level tests miss.

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
      ['7', ['Category Rules', 'Whole Foods']],
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

// ── FilterPanel ─────────────────────────────────────────────────────────────
describe('FilterPanel', () => {
  function panel(initial = {}, onClose = noop) {
    return render(
      <RefreshProvider>
        <TypingContext.Provider value={() => {}}>
          <FilterProvider initial={initial}>
            <FilterPanel isActive onClose={onClose} />
          </FilterProvider>
        </TypingContext.Provider>
      </RefreshProvider>,
    );
  }

  it('shows all four section tabs with counts; only the focused section lists items', async () => {
    const r = panel();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Filter');
      expect(f).toContain('▶ Categories (all)');
      expect(f).toContain('Accounts (all)');
      expect(f).toContain('Owners (all)');
      expect(f).toContain('Tags');
      expect(f).toContain('Grocery');
      // Account rows live on their own tab now
      expect(f).not.toContain('Test Checking');
    });
  });

  it('right arrow switches to the Accounts section', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\x1b[C');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('▶ Accounts (all)');
      expect(f).toContain('Test Checking');
      expect(f).not.toContain('Grocery');
    });
  });

  it('left arrow from Categories wraps around to Tags', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\x1b[D');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('▶ Tags');
      expect(f).toContain('travel');
      expect(f).not.toContain('Grocery');
    });
  });

  it('counts stay visible in the tab header after switching sections', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write(' '); // toggle first category off
    await waitFor(() => expect(frame(r)).toMatch(/▶ Categories \(\d+\/\d+\)/));
    r.stdin.write('\x1b[C');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('▶ Accounts (all)');
      expect(f).toMatch(/Categories \(\d+\/\d+\)/);
    });
  });

  it('keeps a per-section cursor when flipping between tabs', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\x1b[B'); // ↓
    r.stdin.write('\x1b[B'); // ↓ → third category (Grocery)
    await waitFor(() => expect(frame(r)).toContain('▶ ● Grocery'));
    r.stdin.write('\x1b[C'); // → Accounts
    r.stdin.write('\x1b[D'); // ← back
    await waitFor(() => expect(frame(r)).toContain('▶ ● Grocery'));
  });

  it('lowercase n deselects all and a reselects all in the focused section', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('n');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toMatch(/▶ Categories \(0\/\d+\)/);
      expect(f).toContain('○ Grocery');
    });
    r.stdin.write('a');
    await waitFor(() => expect(frame(r)).toContain('▶ Categories (all)'));
  });

  it('i inverts the selection in the focused section', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('n'); // none
    await waitFor(() => expect(frame(r)).toContain('○ Grocery'));
    r.stdin.write('\x1b[B');
    r.stdin.write('\x1b[B');
    await waitFor(() => expect(frame(r)).toContain('▶ ○ Grocery'));
    r.stdin.write(' '); // select only Grocery
    await waitFor(() => expect(frame(r)).toContain('▶ ● Grocery'));
    r.stdin.write('i');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('○ Grocery');
      expect(f).toContain('● Bills & Utilities');
      expect(f).toContain('● Dining');
    });
  });

  it('i on the Tags section swaps has and lacks, leaving off tags off', async () => {
    const r = panel();
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\x1b[D'); // wrap to Tags
    await waitFor(() => expect(frame(r)).toContain('travel'));
    r.stdin.write(' '); // travel → has
    await waitFor(() => expect(frame(r)).toContain('✓ has'));
    r.stdin.write('i');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('✗ lacks');
      expect(f).not.toContain('✓ has');
      expect(f).toContain('○ off'); // work stays off
    });
  });

  it('Esc closes without applying', async () => {
    const onClose = vi.fn();
    const r = panel({}, onClose);
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Enter applies and closes', async () => {
    const onClose = vi.fn();
    const r = panel({}, onClose);
    await waitFor(() => expect(frame(r)).toContain('Grocery'));
    r.stdin.write('\r');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

// ── FilterPanel live preview ───────────────────────────────────────────────
describe('FilterPanel live preview', () => {
  const MAY_DATE_FILTER = { from: '2026-05-01', to: '2026-05-31' };

  function Harness() {
    const [open, setOpen] = React.useState(true);
    return (
      <FilterProvider>
        <Transactions onNavigate={noop} showHints={false} initialFilter={MAY_DATE_FILTER} isActive={!open} />
        {open && <FilterPanel isActive={open} onClose={() => setOpen(false)} />}
      </FilterProvider>
    );
  }

  function harness() {
    return render(<W><Harness /></W>);
  }

  it('toggling categories updates the transaction list before Enter is pressed', async () => {
    const r = harness();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('n'); // deselect all categories → matches nothing
    await waitFor(() => expect(frame(r)).not.toContain('Whole Foods'));
  });

  it('Esc reverts the preview, leaving the committed filter untouched', async () => {
    const r = harness();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).not.toContain('Whole Foods'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    expect(frame(r)).not.toContain('0 categories');
  });

  it('Enter commits the preview and updates the filter summary', async () => {
    const r = harness();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).not.toContain('Whole Foods'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Whole Foods');
      expect(f).toContain('0 categories');
    });
  });

  it('opening and closing without changes leaves the view unchanged', async () => {
    const r = harness();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).not.toContain('Filter'));
    expect(frame(r)).toContain('Whole Foods');
  });

  it('a burst of draft changes collapses into a single preview query (debounce)', async () => {
    // The keystrokes all land within one tick — far under the debounce window —
    // so every intermediate draft is coalesced and only the final state queries.
    const spy = vi.spyOn(queries, 'getTransactions');
    const r = harness();
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    const baseline = spy.mock.calls.length;
    r.stdin.write('n'); // none
    r.stdin.write('a'); // all (== committed)
    r.stdin.write('n'); // none again
    await waitFor(() => expect(frame(r)).not.toContain('Whole Foods'));
    expect(spy.mock.calls.length - baseline).toBe(1);
    spy.mockRestore();
  });
});

// ── FilterPanel live preview — propagation & history ───────────────────────
describe('FilterPanel live preview — propagation & history', () => {
  it('previews on the Dashboard, the screen the panel was opened from', async () => {
    // The panel lists category *names*, so assert on a Dashboard-only signal:
    // the Expenses total ($388.99 for seeded May), which no panel row renders.
    function DashHarness() {
      const [open, setOpen] = React.useState(true);
      return (
        <FilterProvider>
          <Dashboard onNavigate={noop} showHints={false} initialFilter={MAY_FILTER} isActive={!open} />
          {open && <FilterPanel isActive={open} onClose={() => setOpen(false)} />}
        </FilterProvider>
      );
    }
    const r = render(<W><DashHarness /></W>);
    await waitFor(() => expect(frame(r)).toContain('$388.99'));
    r.stdin.write('n'); // deselect all categories → nothing matches
    await waitFor(() => expect(frame(r)).not.toContain('$388.99'));
    expect(frame(r)).toContain('$0.00'); // expenses fall to zero live
  });

  it('previewing many toggles never pushes history; commit pushes exactly one level', async () => {
    // Undated filter so Esc in Transactions pops the filter rather than first
    // clearing a date range (the from/search short-circuits run ahead of pop).
    const probe = { canPop: false };
    function Probe() {
      const { canPop } = useFilter();
      probe.canPop = canPop;
      return null;
    }
    function H() {
      const [open, setOpen] = React.useState(true);
      return (
        <FilterProvider>
          <Probe />
          <Transactions onNavigate={noop} showHints={false} isActive={!open} />
          {open && <FilterPanel isActive={open} onClose={() => setOpen(false)} />}
        </FilterProvider>
      );
    }
    const r = render(<W><H /></W>);
    await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
    // A flurry of draft changes — each would be a history push if preview
    // wrongly committed via setFilter instead of setPreview.
    for (const k of ['n', 'a', 'i', ' ', ' ', 'i', 'n']) r.stdin.write(k);
    await waitFor(() => expect(frame(r)).not.toContain('Whole Foods'));
    expect(probe.canPop).toBe(false); // preview bypassed history entirely
    r.stdin.write('\r'); // Enter commits exactly one level
    await waitFor(() => expect(probe.canPop).toBe(true));
    // One Esc in Transactions steps straight back to the original view.
    r.stdin.write('\x1b');
    await waitFor(() => {
      expect(frame(r)).toContain('Whole Foods');
      expect(probe.canPop).toBe(false);
    });
  });
});

// ── Transactions out-of-order query guard ──────────────────────────────────
describe('Transactions load() race guard', () => {
  // Simulates the live-preview hazard: a slow earlier query resolving after a
  // faster later one. The unfiltered load (no categories) is forced slow; the
  // category-filtered load is fast, so it lands first — the stale slow result
  // that follows must not clobber it.
  function SetFilterOnMount({ filter }: { filter: Filter }) {
    const { setFilter } = useFilter();
    React.useEffect(() => { setFilter(filter); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    return null;
  }

  it('a slow stale query does not overwrite a faster newer one', async () => {
    const realGet = queries.getTransactions;
    const spy = vi.spyOn(queries, 'getTransactions').mockImplementation(async (args) => {
      const rows = await realGet(args);
      const isFiltered = Array.isArray((args.filter ?? {}).categories);
      await new Promise((res) => setTimeout(res, isFiltered ? 10 : 200));
      return rows;
    });
    try {
      const r = render(
        <W>
          <FilterProvider>
            <SetFilterOnMount filter={{ categories: ['Dining'] }} />
            <Transactions onNavigate={noop} showHints={false} />
          </FilterProvider>
        </W>,
      );
      // The fast filtered load settles first: Dining shows, Grocery's merchant doesn't.
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Sweetgreen');
        expect(f).not.toContain('Whole Foods');
      });
      // Give the slow unfiltered load time to resolve and (incorrectly) repaint.
      await new Promise((res) => setTimeout(res, 300));
      expect(frame(r)).toContain('Sweetgreen');
      expect(frame(r)).not.toContain('Whole Foods'); // stale result was discarded
    } finally {
      spy.mockRestore();
    }
  });
});

// ── useLoadGuard ───────────────────────────────────────────────────────────
describe('useLoadGuard', () => {
  it('only the newest token is current; earlier ones are superseded', () => {
    let guard!: ReturnType<typeof useLoadGuard>;
    function Probe() { guard = useLoadGuard(); return null; }
    render(<Probe />);
    const t1 = guard.begin();
    expect(guard.isLatest(t1)).toBe(true);
    const t2 = guard.begin();
    expect(guard.isLatest(t1)).toBe(false); // t1 superseded by t2
    expect(guard.isLatest(t2)).toBe(true);
  });
});

// ── Dashboard out-of-order query guard ─────────────────────────────────────
describe('Dashboard load() race guard', () => {
  // Same hazard as Transactions, on the summary load: the unfiltered summary is
  // forced slow and the category-filtered one fast, so the stale slow result
  // arrives last and must not repaint the Expenses total. Trends shares the
  // identical useLoadGuard pattern (covered above).
  function SetFilterOnMount({ filter }: { filter: Filter }) {
    const { setFilter } = useFilter();
    React.useEffect(() => { setFilter(filter); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
    return null;
  }

  it('a slow stale summary does not overwrite a faster newer one', async () => {
    const realSummary = queries.getRangeSummary;
    const spy = vi.spyOn(queries, 'getRangeSummary').mockImplementation(async (from, to, filter) => {
      const res = await realSummary(from, to, filter);
      const isFiltered = Array.isArray((filter ?? {}).categories);
      await new Promise((res2) => setTimeout(res2, isFiltered ? 10 : 200));
      return res;
    });
    try {
      const r = render(
        <W>
          <FilterProvider>
            <SetFilterOnMount filter={{ categories: ['Dining'] }} />
            <Dashboard onNavigate={noop} showHints={false} initialFilter={MAY_FILTER} />
          </FilterProvider>
        </W>,
      );
      // Fast filtered summary lands first: Dining's $45.00, not the full $388.99.
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('$45.00');
        expect(f).not.toContain('$388.99');
      });
      // Let the slow unfiltered summary resolve and (incorrectly) repaint.
      await new Promise((res) => setTimeout(res, 300));
      expect(frame(r)).toContain('$45.00');
      expect(frame(r)).not.toContain('$388.99'); // stale result was discarded
    } finally {
      spy.mockRestore();
    }
  });
});

