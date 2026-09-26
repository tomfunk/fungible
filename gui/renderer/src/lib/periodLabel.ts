import type { NetWorthGranularity } from '../../../../core/queries.js';
import { MONTHS } from '../constants.js';

/** Formats a history row's `period` bucket key (as produced by
 *  getNetWorthHistory/getHealthHistory) into a short display label for chart
 *  axes/tooltips. Shared by NetWorth and Health's history charts so the two
 *  screens can't drift on how a period string reads. */
export function periodLabel(period: string, granularity: NetWorthGranularity): string {
  if (granularity === 'year') return period;
  if (granularity === 'quarter') {
    const [y, q] = period.split('-');
    return `${q} ${y}`;
  }
  if (granularity === 'month') {
    const [y, m] = period.split('-');
    return `${MONTHS[parseInt(m) - 1]} ${y}`;
  }
  const [y, w] = period.split('-');
  return `${w} ${y}`;
}
