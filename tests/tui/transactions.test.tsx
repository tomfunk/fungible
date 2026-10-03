import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Transactions.tsx's export flow (Issue #18) calls real fs.writeFileSync/
// existsSync against whatever path the user types, which defaults to a file
// under the real os.homedir(). Left unmocked, a test that drives that flow
// end-to-end writes an actual file into the real home directory on every
// contributor's and CI's machine, on every run — nothing else in this file
// touches node:fs (CSV-import-from-a-real-file tests live in
// accounts-imports.test.tsx, not here), so overriding just these two named
// exports is safe for every other test below.
const { fsWriteFileSyncMock, fsExistsSyncMock } = vi.hoisted(() => ({
  fsWriteFileSyncMock: vi.fn(),
  fsExistsSyncMock: vi.fn(() => false),
}));
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  const actualDefault = (actual as unknown as { default?: typeof actual }).default ?? actual;
  return {
    ...actual,
    writeFileSync: fsWriteFileSyncMock,
    existsSync: fsExistsSyncMock,
    default: { ...actualDefault, writeFileSync: fsWriteFileSyncMock, existsSync: fsExistsSyncMock },
  };
});

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Transactions } from '../../tui/Transactions.js';
import { FilterProvider, useFilter } from '../../tui/FilterContext.js';
import type { Filter } from '../../core/filters.js';
import { waitFor, frame, flatFrame } from '../helpers/waitFor.js';
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

useSeededScreenDb();

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
    r.stdin.write('\x1b[B'); // category → date
    r.stdin.write('\x1b[B'); // date → pattern
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
    r.stdin.write('\x1b[B'); // category → date
    r.stdin.write('\x1b[B'); // date → pattern
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
    await waitFor(() => expect(frame(r)).toContain('← Income  →'));
    // Navigate to Pattern and type a pattern
    r.stdin.write('\x1b[B'); // category → date
    r.stdin.write('\x1b[B'); // date → pattern
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

  it('recategorizing without a pattern offers to save a category rule, and [y] saves it', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // panel open
    r.stdin.write('\x1b[B'); // name → category
    await waitFor(() => expect(frame(r)).toContain('(unchanged)'));
    r.stdin.write('\x1b[D'); // cycle Grocery → Dining, no Pattern typed
    await waitFor(() => expect(frame(r)).toContain('← Dining  →'));
    r.stdin.write('\r'); // save — plain recategorize, not saveAsRule
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Always categorize');
      expect(f).toContain('Trader Joes');
      expect(f).toContain('Dining');
      expect(f).toContain('Yes, always');
    });
    r.stdin.write('y');
    await waitFor(() => expect(frame(r)).toContain('Saved: category rule'));
    const rule = await db.execute("SELECT category FROM category_rules WHERE pattern = 'Trader Joes'");
    expect((rule.rows[0] as unknown as { category: string }).category).toBe('Dining');
  });

  it('[n] on the rule prompt declines and creates no rule', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery'));
    r.stdin.write('\x1b[B'); // name → category
    await waitFor(() => expect(frame(r)).toContain('(unchanged)'));
    r.stdin.write('\x1b[D'); // Grocery → Dining
    await waitFor(() => expect(frame(r)).toContain('← Dining  →'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Always categorize'));
    r.stdin.write('n');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Always categorize');
      expect(f).toContain('Trader Joes'); // back on the list
    });
    const rule = await db.execute("SELECT id FROM category_rules WHERE pattern = 'Trader Joes'");
    expect(rule.rows.length).toBe(0);
  });

  it('recategorizing over a conflicting rule offers to update it instead, and [y] repoints it without losing its amount range or account scope', async () => {
    // tx-groc-2 (Trader Joes) is on test-credit, amount 85.00 — the range and
    // account below still match it, so the conflict is still detected, and
    // acceptRuleSuggestion must carry these through rather than nulling them.
    await db.execute(
      "INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount, account_id) " +
      "VALUES (10, 'name', 'Trader Joes', 'Bills & Utilities', 50.00, 200.00, 'test-credit')",
    );
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery'));
    r.stdin.write('\x1b[B'); // name → category
    await waitFor(() => expect(frame(r)).toContain('(unchanged)'));
    r.stdin.write('\x1b[C'); // cycle Grocery → Income, no Pattern typed
    await waitFor(() => expect(frame(r)).toContain('← Income  →'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('already has a rule');
      expect(f).toContain('Bills & Utilities');
      expect(f).toContain('Update that rule to');
      expect(f).toContain('Income');
    });
    r.stdin.write('y');
    await waitFor(() => expect(frame(r)).toContain('Saved: category rule'));
    const rules = await db.execute("SELECT category, min_amount, max_amount, account_id FROM category_rules WHERE pattern = 'Trader Joes'");
    expect(rules.rows.length).toBe(1); // updated in place, not duplicated
    const rule = rules.rows[0] as unknown as { category: string; min_amount: number; max_amount: number; account_id: string };
    expect(rule.category).toBe('Income');
    // The amount range and account scope must survive the update untouched.
    expect(rule.min_amount).toBe(50);
    expect(rule.max_amount).toBe(200);
    expect(rule.account_id).toBe('test-credit');
  });

  it('edit panel shows a Date field prefilled with the transaction date', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => {
      // Trader Joes' posting date, prefilled into the panel's Date field
      expect(flatFrame(r)).toContain('Date [ 2026-05-14 ]');
    });
  });

  it('editing the Date field and Enter reattributes the transaction', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery')); // panel open
    r.stdin.write('\x1b[B'); // name → category
    r.stdin.write('\x1b[B'); // category → date
    await waitFor(() => expect(frame(r)).toContain('(unchanged)')); // date field active
    // Clear the prefilled date and type a new one in April
    for (let i = 0; i < 10; i++) r.stdin.write('\x7f'); // backspace ×10
    await waitFor(() => expect(frame(r)).toContain('YYYY-MM-DD')); // field emptied → placeholder
    for (const ch of '2026-04-30') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('2026-04-30'));
    r.stdin.write('\r'); // save
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Date set to 2026-04-30');
      // Row now sorts/reads under the reattributed date and out of the May window
      expect(f).not.toContain('Trader Joes');
    });
  });

  it('a malformed date shows an error and does not crash', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('← Grocery'));
    r.stdin.write('\x1b[B'); // name → category
    r.stdin.write('\x1b[B'); // category → date
    await waitFor(() => expect(frame(r)).toContain('(unchanged)'));
    for (let i = 0; i < 10; i++) r.stdin.write('\x7f');
    await waitFor(() => expect(frame(r)).toContain('YYYY-MM-DD'));
    for (const ch of '2026-13') r.stdin.write(ch); // wrong shape — rejected before core
    await waitFor(() => expect(frame(r)).toContain('2026-13'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Invalid date');
      expect(f).toContain('Trader Joes'); // still there, panel stayed put, no crash
    });
  });

  it('marks a reattributed row and restores its posting date with [d]', async () => {
    // Reattribute a May row's date to April, keeping its posting date.
    await db.execute({
      sql: 'UPDATE transactions SET original_date = ?, date = ? WHERE id = ?',
      args: ['2026-04-28', '2026-05-14', 'tx-groc-2'],
    });
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    // Row carries the reattribution marker (asterisk flush against the date)
    await waitFor(() => expect(frame(r)).toContain('2026-05-14*'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('posted 2026-04-28')); // edit panel context line
    r.stdin.write('\x1b'); // Esc back to the list
    await waitFor(() => expect(frame(r)).not.toContain('posted 2026-04-28'));
    r.stdin.write('d'); // restore posting date
    await waitFor(() => expect(frame(r)).toContain('Date restored to 2026-04-28'));
    await waitFor(() => expect(frame(r)).not.toContain('2026-05-14*'));
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

  // ── Add transaction ([n]) ───────────────────────────────────────────────────

  it('[n] opens the add-transaction panel with all fields', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('n');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Add transaction');
      expect(f).toContain('Date');
      expect(f).toContain('Name');
      expect(f).toContain('Amount');
      expect(f).toContain('Type');
      expect(f).toContain('Account');
      expect(f).toContain('Category');
      // Account/category pickers default to the first row of each — seeded
      // depository account and alphabetically-first category.
      expect(f).toContain('← Test Checking');
      expect(f).toContain('← Bills & Utilities');
      expect(f).toContain('← Expense');
    });
  });

  it('Esc cancels the add-transaction panel without creating a row', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    const before = (await db.execute('SELECT COUNT(*) as n FROM transactions')).rows[0] as unknown as { n: number };
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Add transaction'));
    for (const ch of 'Coffee') r.stdin.write(ch);
    r.stdin.write('\x1b');
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Add transaction');
      expect(f).toContain('Trader Joes');
    });
    const after = (await db.execute('SELECT COUNT(*) as n FROM transactions')).rows[0] as unknown as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('Enter on an empty Name shows a validation error and keeps the panel open', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Add transaction'));
    r.stdin.write('\r'); // Name is still empty — Date field is prefilled but that's not what's missing
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Name is required');
      expect(f).toContain('Add transaction'); // panel still open
    });
  });

  it('filling the form and Enter creates a manual, source=manual transaction with the signed amount', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Add transaction'));
    // Date field is active first, prefilled with today's real date — clear it
    // and set one inside the May filter so the new row is visible after reload.
    for (let i = 0; i < 10; i++) r.stdin.write('\x7f');
    await waitFor(() => expect(frame(r)).toContain('YYYY-MM-DD'));
    for (const ch of '2026-05-20') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('2026-05-20'));
    r.stdin.write('\x1b[B'); // date → name
    await waitFor(() => expect(frame(r)).toContain('e.g. Coffee shop')); // Name field active & empty
    for (const ch of 'Coffee Shop') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('Coffee Shop'));
    r.stdin.write('\x1b[B'); // name → amount
    await waitFor(() => expect(frame(r)).toContain('0.00')); // Amount field active & empty
    for (const ch of '12.50') r.stdin.write(ch);
    await waitFor(() => expect(frame(r)).toContain('12.50'));
    // Type/Account/Category left at their defaults: Expense, Test Checking, Bills & Utilities.
    r.stdin.write('\r'); // save
    await waitFor(() => {
      const f = frame(r);
      expect(f).not.toContain('Add transaction'); // panel closed
      expect(f).toContain('Transaction added');
      expect(f).toContain('Coffee Shop'); // reloaded list shows the new row
    });
    const row = (await db.execute(
      "SELECT amount, source, account_id, category, date FROM transactions WHERE name = 'Coffee Shop'",
    )).rows[0] as unknown as { amount: number; source: string; account_id: string; category: string; date: string };
    expect(row.amount).toBe(12.5); // Expense → positive, matching fmt()'s convention
    expect(row.source).toBe('manual');
    expect(row.account_id).toBe('test-checking');
    expect(row.category).toBe('Bills & Utilities');
    expect(row.date).toBe('2026-05-20');
  });

  it('toggling Type to Income flips the stored sign to negative', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('Add transaction'));
    for (let i = 0; i < 10; i++) r.stdin.write('\x7f');
    await waitFor(() => expect(frame(r)).toContain('YYYY-MM-DD'));
    for (const ch of '2026-05-20') r.stdin.write(ch);
    r.stdin.write('\x1b[B'); // date → name
    await waitFor(() => expect(frame(r)).toContain('e.g. Coffee shop'));
    for (const ch of 'Refund') r.stdin.write(ch);
    r.stdin.write('\x1b[B'); // name → amount
    await waitFor(() => expect(frame(r)).toContain('0.00'));
    for (const ch of '20') r.stdin.write(ch);
    r.stdin.write('\x1b[B'); // amount → type
    await waitFor(() => expect(frame(r)).toContain('← Expense'));
    r.stdin.write('\x1b[C'); // → toggle Expense to Income
    await waitFor(() => expect(frame(r)).toContain('← Income'));
    r.stdin.write('\r'); // save
    await waitFor(() => expect(frame(r)).toContain('Transaction added'));
    const row = (await db.execute("SELECT amount FROM transactions WHERE name = 'Refund'")).rows[0] as unknown as { amount: number };
    expect(row.amount).toBe(-20);
  });

  it('← → on the Account field cycles to the other seeded account', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('n');
    await waitFor(() => expect(frame(r)).toContain('← Test Checking'));
    r.stdin.write('\x1b[B'); // date → name
    r.stdin.write('\x1b[B'); // name → amount
    r.stdin.write('\x1b[B'); // amount → type
    r.stdin.write('\x1b[B'); // type → account
    await waitFor(() => expect(frame(r)).toContain('← Test Checking'));
    r.stdin.write('\x1b[C'); // → cycle to the credit account
    await waitFor(() => expect(frame(r)).toContain('← Test Visa'));
  });

  it('a manually-added row can be deleted with [x], same as a CSV row', async () => {
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, source)
            VALUES ('tx-manual-1', 'test-checking', '2026-05-18', 'Hand-typed refund', -5.00, 'Income', 'manual')`,
    });
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    // Search narrows the list to just this row, so it's unambiguously under
    // the cursor without depending on sort order or row position.
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('Esc cancel')); // search bar active — 'n' in the query below must not hit the list's [n] add binding
    for (const ch of 'Hand-typed') r.stdin.write(ch);
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Hand-typed refund');
      expect(f).toContain('1 transactions');
    });
    r.stdin.write('x');
    await waitFor(() => expect(frame(r)).not.toContain('Hand-typed refund'));
    const row = await db.execute("SELECT id FROM transactions WHERE id = 'tx-manual-1'");
    expect(row.rows.length).toBe(0);
  });

  it('[i] ignores/un-ignores a synced (non-manual) transaction', async () => {
    const r = txns();
    await waitFor(() => expect(frame(r)).toContain('Trader Joes')); // newest May row, source=null (seeded)
    r.stdin.write('i');
    await waitFor(() => expect(frame(r)).toContain('~Grocery')); // ignored marker on the category cell
    r.stdin.write('i');
    await waitFor(() => expect(frame(r)).not.toContain('~Grocery'));
  });

  it('[i] is a no-op on a manually-added row, and the hint line drops [i] ignore for it', async () => {
    await db.execute({
      sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, source)
            VALUES ('tx-manual-1', 'test-checking', '2026-05-18', 'Hand-typed refund', -5.00, 'Income', 'manual')`,
    });
    // Ignoring a hand-typed row doesn't make sense — if it shouldn't count,
    // delete it outright (issue: gate [i] off for source='manual', matching
    // how GUI drops its ignore button for the same rows).
    const r = txns({ showHints: true });
    await waitFor(() => expect(frame(r)).toContain('Trader Joes'));
    r.stdin.write('/');
    await waitFor(() => expect(frame(r)).toContain('Esc cancel'));
    for (const ch of 'Hand-typed') r.stdin.write(ch);
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Hand-typed refund');
      expect(f).toContain('1 transactions');
    });
    // Hint line no longer advertises [i] ignore once the selected row is manual.
    expect(frame(r)).not.toContain('[i] ignore');
    r.stdin.write('i');
    await new Promise((res) => setTimeout(res, 50)); // nothing to waitFor — proving absence of a change
    expect(frame(r)).not.toContain('~Hand-typed');
    const row = (await db.execute(
      "SELECT ignored FROM transactions WHERE id = 'tx-manual-1'",
    )).rows[0] as unknown as { ignored: number };
    expect(row.ignored).toBe(0);
  });

  // ── Export (Issue #18) ───────────────────────────────────────────────────
  // All assertions here go through fsWriteFileSyncMock/fsExistsSyncMock (set
  // up near the top of this file) rather than a real path under a real
  // tmpdir/homedir — see that mock's comment for why. existsSyncMock defaults
  // to false (acts like a fresh destination) and is overridden per-test via
  // mockReturnValue for the overwrite-confirm case.
  describe('export', () => {
    beforeEach(() => {
      fsWriteFileSyncMock.mockClear();
      fsExistsSyncMock.mockClear();
      fsExistsSyncMock.mockReturnValue(false);
    });

    /** Clears whatever's in the export path field — used instead of counting
     *  exact backspaces since the real default embeds os.homedir(), whose
     *  length isn't fixed across machines. */
    function clearPathField(r: ReturnType<typeof render>) {
      for (let i = 0; i < 200; i++) r.stdin.write('\x7f');
    }

    it('e opens the export panel prefilled with a homedir default path', async () => {
      const r = txns();
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('e');
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Export transactions to CSV');
        expect(f).toContain('transactions-export-');
        expect(f).toContain('.csv');
      });
      expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
    });

    it('Esc cancels the export panel without writing anything', async () => {
      const r = txns();
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('e');
      await waitFor(() => expect(frame(r)).toContain('Export transactions to CSV'));
      r.stdin.write('\x1b');
      await waitFor(() => expect(frame(r)).not.toContain('Export transactions to CSV'));
      expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
    });

    it('writes every row in the current date range to the chosen path, uncapped by the 200-row screen limit', async () => {
      const destPath = '/fake/export/out.csv';
      const r = txns();
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('e');
      await waitFor(() => expect(frame(r)).toContain('Export transactions to CSV'));
      clearPathField(r);
      for (const ch of destPath) r.stdin.write(ch);
      r.stdin.write('\r');
      await waitFor(() => expect(frame(r)).toContain('Exported 6 transactions'));
      expect(frame(r)).not.toContain('Export transactions to CSV'); // panel closed

      expect(fsWriteFileSyncMock).toHaveBeenCalledTimes(1);
      const [writtenPath, csv, encoding] = fsWriteFileSyncMock.mock.calls[0];
      expect(writtenPath).toBe(destPath);
      expect(encoding).toBe('utf-8');
      const lines = (csv as string).trimEnd().split('\n');
      expect(lines[0]).toBe('date,name,display_name,amount,category,account,tags,is_ignored,is_pending');
      expect(lines.length).toBe(7); // header + 6 May rows
      expect(csv).toContain('Whole Foods');
      expect(csv).toContain('Trader Joes');
      expect(csv).toContain('Test Visa'); // account column, via COALESCE(nickname, name)
      expect(csv).toContain('Test Checking');
    });

    it('search narrows the export to the matching rows, same as the on-screen list', async () => {
      const destPath = '/fake/export/out.csv';
      const r = txns();
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('/');
      await waitFor(() => expect(frame(r)).toContain('Esc cancel'));
      for (const ch of 'Trader Joes') r.stdin.write(ch);
      r.stdin.write('\r');
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Trader Joes');
        expect(f).not.toContain('Whole Foods');
      });
      r.stdin.write('e');
      await waitFor(() => expect(frame(r)).toContain('Export transactions to CSV'));
      clearPathField(r);
      for (const ch of destPath) r.stdin.write(ch);
      r.stdin.write('\r');
      await waitFor(() => expect(frame(r)).toContain('Exported 1 transaction'));

      expect(fsWriteFileSyncMock).toHaveBeenCalledTimes(1);
      const csv = fsWriteFileSyncMock.mock.calls[0][1] as string;
      expect(csv).toContain('Trader Joes');
      expect(csv).not.toContain('Whole Foods');
    });

    it('prompts to overwrite when the destination already exists, and [n] returns to the path step untouched', async () => {
      const destPath = '/fake/export/existing.csv';
      fsExistsSyncMock.mockReturnValue(true);
      const r = txns();
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('e');
      await waitFor(() => expect(frame(r)).toContain('Export transactions to CSV'));
      clearPathField(r);
      for (const ch of destPath) r.stdin.write(ch);
      r.stdin.write('\r');
      await waitFor(() => expect(frame(r)).toContain('already exists'));
      // Declining leaves the file alone and returns to the editable path step.
      r.stdin.write('n');
      await waitFor(() => expect(frame(r)).toContain('Export transactions to CSV'));
      expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
      // Accepting overwrites it.
      r.stdin.write('\r');
      await waitFor(() => expect(frame(r)).toContain('already exists'));
      r.stdin.write('y');
      await waitFor(() => expect(frame(r)).toContain('Exported 6 transactions'));
      expect(fsWriteFileSyncMock).toHaveBeenCalledTimes(1);
      expect(fsWriteFileSyncMock.mock.calls[0][0]).toBe(destPath);
      expect(fsWriteFileSyncMock.mock.calls[0][1]).toContain('Whole Foods');
    });

    it('shows a caveat when a txType/flex drill-in filter is active, since export does not support those dimensions', async () => {
      const r = render(
        <W>
          <Transactions onNavigate={noop} showHints={false} initialFilter={{ from: '2026-05-01', to: '2026-05-31', txType: 'expenses' }} />
        </W>,
      );
      await waitFor(() => expect(frame(r)).toContain('Whole Foods'));
      r.stdin.write('e');
      await waitFor(() => {
        const f = frame(r);
        expect(f).toContain('Export transactions to CSV');
        expect(f).toContain("isn't applied to the exported file");
      });
    });
  });
});
