import type { HealthData } from '../../core/health.js';

/**
 * Builds a HealthData fixture, mirroring the BASE object hand-rolled in
 * tests/tui/health-debt.test.tsx (a debt-free household with a comfortable
 * cash/liquid/retirement split) so callers only need to override the fields
 * their test actually cares about.
 */
export function makeHealthData(overrides: Partial<HealthData> = {}): HealthData {
  return {
    avgMonthlyExpenses: 4000,
    monthlyIncome: 8000,
    monthlySavings: 2000,
    cash: 30000,
    liquid: 50000,
    retirement: 100000,
    totalDebt: 0,
    loanDebt: 0,
    netWorth: 150000,
    basis: 'trailing-365d',
    basisLabel: 'trailing 12mo',
    ...overrides,
  };
}
