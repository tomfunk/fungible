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
import { NetWorth } from '../../tui/NetWorth.js';
import { Accounts } from '../../tui/Accounts.js';
import { waitFor, frame } from '../helpers/waitFor.js';
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

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

  it('shows the balance-history import hint', async () => {
    const r = networth();
    await waitFor(() => expect(frame(r)).toContain('Import history: Accounts → Add Data → [b]'));
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
