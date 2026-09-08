import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { HealthData } from '../../core/health.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// The DEBT section splits credit-card debt (HealthData.totalDebt) from loan debt
// (HealthData.loanDebt, added when loan accounts started counting as liabilities).

const BASE: HealthData = {
  avgMonthlyExpenses: 4000,
  monthlyIncome: 8000,
  monthlySavings: 2000,
  savingsRate: 25,
  cash: 30000,
  liquid: 50000,
  retirement: 100000,
  totalDebt: 0,
  loanDebt: 0,
  netWorth: 150000,
};

let health: HealthData = { ...BASE };

vi.mock('../../core/health.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/health.js')>();
  return { ...actual, loadHealthData: async () => health };
});

vi.mock('../../core/settings.js', () => ({
  PRETAX_MONTHLY_KEY: 'pretax_monthly',
  getSetting: async () => null,
  setSetting: async () => {},
}));

vi.mock('../../core/profile.js', () => ({
  loadProfile: async () => null,
  householdMembers: () => [],
}));

const { Health } = await import('../../tui/Health.js');

const noop = () => {};
const frame = (r: ReturnType<typeof render>) => r.lastFrame() ?? '';
async function waitFor(fn: () => void) {
  for (let i = 0; i < 50; i++) {
    try { fn(); return; } catch { await new Promise((res) => setTimeout(res, 10)); }
  }
  fn();
}

beforeEach(() => { health = { ...BASE }; });

describe('Health — DEBT section with loan debt', () => {
  it('hides the DEBT section when there is neither card nor loan debt', async () => {
    const r = render(<Health onNavigate={noop} showHints={false} isActive />);
    await waitFor(() => expect(frame(r)).toContain('RETIREMENT'));
    expect(frame(r)).not.toContain('DEBT');
  });

  it('shows only the credit-card view when there is no loan debt', async () => {
    health = { ...BASE, totalDebt: 5000, cash: 30000 };
    const r = render(<Health onNavigate={noop} showHints={false} isActive />);
    await waitFor(() => expect(frame(r)).toContain('DEBT'));
    const f = frame(r);
    expect(f).toContain('Net cash');
    expect(f).not.toContain('Loans');
    expect(f).not.toMatch(/\bTotal\b/);
  });

  it('breaks out Credit cards / Loans / Total when there is loan debt', async () => {
    health = { ...BASE, totalDebt: 4000, loanDebt: 296000, cash: 30000, netWorth: -150000 };
    const r = render(<Health onNavigate={noop} showHints={false} isActive />);
    await waitFor(() => expect(frame(r)).toContain('DEBT'));
    const f = frame(r);
    expect(f).toContain('Credit cards');
    expect(f).toContain('$4,000');
    expect(f).toContain('Loans');
    expect(f).toContain('$296,000');
    expect(f).toContain('mortgage / auto / student');
    expect(f).toContain('Total');
    expect(f).toContain('$300,000');
  });

  it('shows the section for a loan-only borrower and omits the card payoff rows', async () => {
    health = { ...BASE, totalDebt: 0, loanDebt: 300000, netWorth: -150000 };
    const r = render(<Health onNavigate={noop} showHints={false} isActive />);
    await waitFor(() => expect(frame(r)).toContain('DEBT'));
    const f = frame(r);
    expect(f).toContain('Loans');
    expect(f).toContain('Total');
    expect(f).not.toContain('Net cash');
    expect(f).not.toContain('Debt-free in');
  });
});
