import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { App } from '../../tui/App.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts } from '../../tui/Accounts.js';
import * as accountsApi from '../../core/accounts.js';
import { Health } from '../../tui/Health.js';
import { Settings } from '../../tui/Settings.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

vi.mock('../../core/profile.js', () => ({
  loadProfile: () => null,
  saveProfile: () => {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;

function frame(r: ReturnType<typeof render>): string {
  return (r.lastFrame() ?? '').replace(ANSI_RE, '');
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
  for (const tbl of ['transactions', 'accounts', 'categories', 'tags', 'transaction_tags',
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

  it('d key toggles delta mode label', async () => {
    const r = dash();
    await waitFor(() => expect(frame(r)).toContain('Income'));
    r.stdin.write('d');
    await waitFor(() => expect(frame(r)).toContain('delta'));
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

  it('shows category filter label when category is provided', async () => {
    const r = txns({ initialFilter: { ...MAY_DATE_FILTER, category: 'Grocery' } });
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Grocery');
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

  it('Tab Tab cycles to Categories section showing seeded categories', async () => {
    const r = rules();
    await waitFor(() => expect(frame(r)).toContain('Category Rules'));
    r.stdin.write('\t');
    r.stdin.write('\t');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Grocery');
      expect(f).toContain('Dining');
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
});
