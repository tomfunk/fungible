import { MONTHS } from '../core/dateUtils.js';

export const BAR_WIDTH = 20;

export function bar(amount: number, max: number, width = BAR_WIDTH): string {
  const filled = max > 0 ? Math.min(width, Math.max(0, Math.round((Math.abs(amount) / max) * width))) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── Period-history rendering ────────────────────────────────────────────────
// Shared by any screen that renders a getNetWorthHistory/getHealthHistory-style
// period-bucketed row list (NetWorth.tsx, Health.tsx's History mode) so the
// range cycling and period-label formatting can't drift apart between them.

export type HistoryRange = 'week' | 'month' | 'quarter' | 'year';
export const HISTORY_RANGES: HistoryRange[] = ['week', 'month', 'quarter', 'year'];
export const HISTORY_RANGE_LABELS: Record<HistoryRange, string> = {
  week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year',
};

/** Formats a period-bucket key (as produced by core's `period` grouping expressions) for display, e.g. '2026-05' -> 'May 2026', '2026-Q2' -> 'Q2 2026'. */
export function periodLabel(period: string, range: HistoryRange): string {
  if (range === 'year') return period;
  if (range === 'quarter') {
    const [y, q] = period.split('-');
    return `${q} ${y}`;
  }
  if (range === 'month') {
    const [y, m] = period.split('-');
    return `${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  const [y, w] = period.split('-');
  return `${w} ${y}`;
}

/** Column width to reserve for a periodLabel() result at the given range, so history list rows line up. */
export function periodLabelWidth(range: HistoryRange): number {
  return range === 'year' ? 4 : range === 'quarter' ? 7 : range === 'month' ? 8 : 12;
}
