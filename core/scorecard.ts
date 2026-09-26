import type { CategoryDrift } from './queries.js';
import type { SeverityLevel } from './severity.js';

// Pure bucketing of drift rows into a scorecard verdict. Kept free of DB and
// UI imports so the GUI renderer can import it directly (no bridge needed).

export type Scorecard = {
  over: CategoryDrift[];    // significantly above baseline, worst first
  typical: CategoryDrift[]; // within the noise band, input order preserved
  under: CategoryDrift[];   // significantly below baseline, biggest saving last
  net: number;              // sum of medianDelta across ALL rows (incl. typical)
};

// A delta only counts as signal when it clears both an absolute floor and a
// share of the category's own baseline — $40 over on a $60 baseline matters,
// $40 over on a $4,000 baseline doesn't.
export const SIGNIFICANCE_FLOOR = 50;
export const SIGNIFICANCE_SHARE = 0.15;

export function isSignificantDelta(delta: number, baseline: number): boolean {
  return Math.abs(delta) >= Math.max(SIGNIFICANCE_FLOOR, SIGNIFICANCE_SHARE * baseline);
}

/** "4.2x" multiplier vs baseline; "n/a" when there is no baseline to compare. */
export function ratioLabel(current: number, baseline: number): string {
  if (baseline <= 0) return current > 0 ? 'n/a' : '';
  return `${(current / baseline).toFixed(1)}x`;
}

// A drift ratio of 1.3x+ vs the 12mo median crosses from "worth a yellow
// flag" to "worth a red one". A zero baseline (brand-new category, no
// history) has no ratio to compute and is always treated as high severity --
// see isHighSeverityDrift.
export const HIGH_DRIFT_RATIO = 1.3;

export function isHighSeverityDrift(current: number, median12m: number): boolean {
  return median12m === 0 || current / median12m >= HIGH_DRIFT_RATIO;
}

/**
 * Combines isSignificantDelta + isHighSeverityDrift into the 3 rendered bands
 * gui/tui currently derive locally as pos/warn/neg (driftClass/driftColor).
 *
 * Note: median12m === 0 with current !== 0 now always reads as 'bad' via
 * isHighSeverityDrift's explicit zero-baseline guard. The old inline gui/tui
 * code computed `current / median12m >= 1.3` directly, which is `NaN >= 1.3`
 * (false) when median12m is 0 -- silently landing a brand-new category with
 * no history in the "moderate" band instead of "high severity". This matches
 * what core/tools.ts's MCP scorecard emoji rendering already did correctly.
 */
export function driftSeverity(current: number, median12m: number): SeverityLevel {
  const medianDelta = current - median12m;
  if (current === 0 && median12m === 0) return 'neutral';
  if (!isSignificantDelta(medianDelta, median12m)) return 'neutral';
  if (medianDelta < 0) return 'good';
  return isHighSeverityDrift(current, median12m) ? 'bad' : 'caution';
}

export function bucketDrift(rows: CategoryDrift[]): Scorecard {
  const over: CategoryDrift[] = [];
  const typical: CategoryDrift[] = [];
  const under: CategoryDrift[] = [];
  let net = 0;
  for (const row of rows) {
    net += row.medianDelta;
    if (!isSignificantDelta(row.medianDelta, row.median12m)) typical.push(row);
    else if (row.medianDelta > 0) over.push(row);
    else under.push(row);
  }
  over.sort((a, b) => b.medianDelta - a.medianDelta);
  // Ascending magnitude so the biggest saving sits last — extremes at the
  // visual edges of the OVER…UNDER stack.
  under.sort((a, b) => b.medianDelta - a.medianDelta);
  return { over, typical, under, net };
}
