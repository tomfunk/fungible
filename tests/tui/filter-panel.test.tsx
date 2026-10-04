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
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { FilterPanel } from '../../tui/FilterPanel.js';
import { Tags } from '../../tui/Tags.js';
import { Accounts } from '../../tui/Accounts.js';
import { FilterProvider, useFilter } from '../../tui/FilterContext.js';
import type { Filter } from '../../core/filters.js';
import { waitFor as baseWaitFor, frame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, MAY_FILTER, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

useSeededScreenDb();

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
