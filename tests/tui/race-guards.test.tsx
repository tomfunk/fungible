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

import * as queries from '../../core/queries.js';
import { useLoadGuard } from '../../tui/useLoadGuard.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { FilterProvider, useFilter } from '../../tui/FilterContext.js';
import type { Filter } from '../../core/filters.js';
import { waitFor as baseWaitFor, frame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, MAY_FILTER, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

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
