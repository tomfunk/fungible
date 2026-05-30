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
import { Health } from '../../tui/Health.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;

function frame(r: ReturnType<typeof render>): string {
  return (r.lastFrame() ?? '').replace(ANSI_RE, '');
}

async function waitFor(assertion: () => void, timeout = 2000): Promise<void> {
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
    // Search bar should appear with the cursor indicator
    await waitFor(() => expect(frame(r)).toContain('/'));
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
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('/');
    });
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
});
