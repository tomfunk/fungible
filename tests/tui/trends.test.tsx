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
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import * as syncApi from '../../core/sync.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('Trends', () => {
  afterEach(() => vi.restoreAllMocks());

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

  it('S key syncs and shows a toast with the added count', async () => {
    vi.spyOn(syncApi, 'syncAll').mockResolvedValue([
      { itemId: 'item-a', added: 5, modified: 0, removed: 0, dupes: 0, skipped: false },
    ]);
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
    r.stdin.write('S');
    expect(syncApi.syncAll).toHaveBeenCalledWith(true);
    await waitFor(() => expect(frame(r)).toContain('Synced — 5 new'));
  });

  it('S key shows a failure toast when sync rejects', async () => {
    vi.spyOn(syncApi, 'syncAll').mockRejectedValue(new Error('boom'));
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('Expenses'));
    r.stdin.write('S');
    await waitFor(() => expect(frame(r)).toContain('Sync failed'));
  });

  // A successful sync must reload what's on screen, not just show a toast —
  // simulate syncAll actually writing a new transaction, the way a real Plaid
  // sync would, and confirm the May period's expense total picks it up
  // without any other user action (period/view change).
  it('S key reloads displayed period totals after sync adds data', async () => {
    vi.spyOn(syncApi, 'syncAll').mockImplementation(async () => {
      await db.execute(
        `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
         VALUES ('tx-synced', 'test-credit', '2026-05-12', 'New From Sync', 12345.67, 'Shopping', 0, 0)`,
      );
      return [{ itemId: 'item-a', added: 1, modified: 0, removed: 0, dupes: 0, skipped: false }];
    });
    const r = trends();
    await waitFor(() => expect(frame(r)).toContain('May 2026'));
    // Baseline May expenses (120 + 85 + 45 + 95 + 43.99) is 388.99; adding the
    // synced 12,345.67 makes the period total 12,734.66.
    expect(frame(r)).not.toContain('12,734.66');
    r.stdin.write('S');
    await waitFor(() => expect(frame(r)).toContain('12,734.66'));
  });
});
