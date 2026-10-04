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
import { App } from '../../tui/App.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Health } from '../../tui/Health.js';
import { waitFor as baseWaitFor, frame } from '../helpers/waitFor.js';

// Screen loads run slower under coverage/CI load; give every wait generous headroom.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);
vi.setConfig({ testTimeout: 30_000 });
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

useSeededScreenDb();

describe('Health', () => {
  function health(overrides?: Partial<Parameters<typeof Health>[0]>) {
    return render(
      <W>
        <Health onNavigate={noop} showHints={false} {...overrides} />
      </W>,
    );
  }

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

  // ── History mode ──────────────────────────────────────────────────────────
  // 't' (not 'h' — that's App.tsx's global hints toggle) opens the full
  // metric/range/pagination History drill-down directly (reusing NetWorth.tsx's
  // period-bucketed bar/value list pattern). Esc (or 't' again) closes it,
  // going straight back to the Snapshot view.

  it("'t' opens the full History view directly (metric header, range tabs)", async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('History — Savings rate'));
    expect(frame(r)).not.toContain('ASSUMPTIONS');
    expect(frame(r)).toContain('Quarter'); // range tabs appear right away
  });

  it("Esc closes History and goes straight back to the Snapshot view", async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('Quarter'));
    r.stdin.write('\x1b');
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
  });

  it('digit-nav is suppressed while History is open', async () => {
    const onNavigate = vi.fn();
    const r = render(<W><Health onNavigate={onNavigate} showHints={false} /></W>);
    await waitFor(() => expect(frame(r)).toContain('Financial Health'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('Quarter'));
    r.stdin.write('1');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('← → cycle through the seven chartable metrics, wrapping in both directions', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('History — Savings rate'));
    r.stdin.write('\x1B[C'); // right
    await waitFor(() => expect(frame(r)).toContain('History — Cash runway'));
    r.stdin.write('\x1B[D'); // left back to the first metric
    await waitFor(() => expect(frame(r)).toContain('History — Savings rate'));
    r.stdin.write('\x1B[D'); // left wraps to the last metric
    await waitFor(() => expect(frame(r)).toContain('History — Coast FIRE'));
  });

  it('shows the "today\'s assumptions" caption only for the FIRE-projection metrics', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('History — Savings rate'));
    expect(frame(r)).not.toContain('assumptions applied to past balances');
    for (let i = 0; i < 5; i++) r.stdin.write('\x1B[C'); // -> Years to FIRE
    await waitFor(() => expect(frame(r)).toContain('History — Years to FIRE'));
    expect(frame(r)).toContain("Using today's growth/withdrawal-rate assumptions applied to past balances.");
    r.stdin.write('\x1B[C'); // -> Coast FIRE
    await waitFor(() => expect(frame(r)).toContain('History — Coast FIRE'));
    expect(frame(r)).toContain("Using today's growth/withdrawal-rate assumptions applied to past balances.");
  });

  it('[r] cycles the range, changing how periods are labeled', async () => {
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('May 2026')); // month range, seeded balance @ 2026-05-20
    r.stdin.write('r'); // month -> quarter
    await waitFor(() => expect(frame(r)).toContain('Q2 2026'));
  });

  it('renders a row per balance-history period once more than one exists', async () => {
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('test-checking', 4500.00, '2026-04-20')");
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Apr 2026');
      expect(f).toContain('May 2026');
    });
  });

  it('charts a raw retirement balance (fmtCompact, not runway/FIRE math)', async () => {
    await db.execute(`INSERT INTO accounts (id, name, type, subtype, institution_name, mask)
                       VALUES ('test-401k', 'Test 401k', 'investment', '401k', 'Test Bank', '0003')`);
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('test-401k', 50000.00, '2026-05-20')");
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('Quarter'));
    for (let i = 0; i < 4; i++) r.stdin.write('\x1B[C'); // -> Retirement Balance
    await waitFor(() => expect(frame(r)).toContain('History — Retirement Balance'));
    await waitFor(() => expect(frame(r)).toContain('$50.0K'));
  });

  it('shows a fallback message when there is no balance history', async () => {
    await db.execute('DELETE FROM balance_history');
    const r = health();
    await waitFor(() => expect(frame(r)).toContain('ASSUMPTIONS'));
    r.stdin.write('t');
    await waitFor(() => expect(frame(r)).toContain('No balance history yet.'));
  });
});
