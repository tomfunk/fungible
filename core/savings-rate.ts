/**
 * Savings rate as a percentage of gross (pretax-inclusive) monthly income.
 * monthlyIncome/monthlySavings are take-home (transactions-only); pretaxMonthly
 * (401k/HSA contributions, not visible in transactions) is added to both sides
 * so the rate reflects total savings against gross pay. Returns null when
 * gross income is 0 (nothing to divide by).
 *
 * Deliberately dependency-free (no db.js/crypto.js in its import graph) so the
 * GUI renderer — a real browser bundle — can import it directly without
 * pulling in node:fs-dependent modules that Rollup can't polyfill for a
 * browser target.
 */
export function computeSavingsRate(
  monthlyIncome: number,
  monthlySavings: number,
  pretaxMonthly: number,
): number | null {
  const grossMonthlyIncome = monthlyIncome + pretaxMonthly;
  return grossMonthlyIncome > 0
    ? ((monthlySavings + pretaxMonthly) / grossMonthlyIncome) * 100
    : null;
}
