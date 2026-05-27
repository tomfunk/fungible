export type Range = 'week' | 'month' | 'quarter' | 'year' | 'alltime';
export const RANGES: Range[] = ['week', 'month', 'quarter', 'year', 'alltime'];
export const RANGE_LABELS: Record<Range, string> = {
  week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year', alltime: 'All',
};

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number) { return String(n).padStart(2, '0'); }
function toStr(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export function getPeriodStart(range: Range, d: Date): Date {
  switch (range) {
    case 'week': {
      const day = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
      monday.setHours(0, 0, 0, 0);
      return monday;
    }
    case 'month':   return new Date(d.getFullYear(), d.getMonth(), 1);
    case 'quarter': return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
    case 'year':    return new Date(d.getFullYear(), 0, 1);
    case 'alltime': return new Date(2000, 0, 1);
  }
}

export function getPeriodDates(range: Range, anchor: Date): { from: string; to: string } {
  if (range === 'alltime') return { from: '2000-01-01', to: '2099-12-31' };
  const from = toStr(anchor);
  let end: Date;
  switch (range) {
    case 'week':    end = new Date(anchor); end.setDate(anchor.getDate() + 6); break;
    case 'month':   end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0); break;
    case 'quarter': end = new Date(anchor.getFullYear(), anchor.getMonth() + 3, 0); break;
    case 'year':    end = new Date(anchor.getFullYear(), 11, 31); break;
  }
  return { from, to: toStr(end) };
}

export function navigatePeriod(range: Range, anchor: Date, delta: -1 | 1): Date {
  const d = new Date(anchor);
  switch (range) {
    case 'week':    d.setDate(d.getDate() + delta * 7); break;
    case 'month':   d.setMonth(d.getMonth() + delta); break;
    case 'quarter': d.setMonth(d.getMonth() + delta * 3); break;
    case 'year':    d.setFullYear(d.getFullYear() + delta); break;
    case 'alltime': break;
  }
  return d;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekLabel(from: string, to: string): string {
  const d1 = new Date(from + 'T12:00:00');
  const d2 = new Date(to + 'T12:00:00');
  const m1 = MONTHS[d1.getMonth()]; const m2 = MONTHS[d2.getMonth()];
  if (m1 === m2) return `${m1} ${d1.getDate()}–${d2.getDate()} ${d1.getFullYear()}`;
  if (d1.getFullYear() === d2.getFullYear()) return `${m1} ${d1.getDate()} – ${m2} ${d2.getDate()} ${d1.getFullYear()}`;
  return `${m1} ${d1.getDate()} ${d1.getFullYear()} – ${m2} ${d2.getDate()} ${d2.getFullYear()}`;
}

export type TrendsRange = 'week' | 'month' | 'quarter' | 'year';

const Q_FROM = ['01', '04', '07', '10'];
const Q_TO   = ['03', '06', '09', '12'];

export function generatePeriods(
  range: TrendsRange,
  from: string,
  to: string,
): Array<{ label: string; from: string; to: string }> {
  const result: Array<{ label: string; from: string; to: string }> = [];

  if (range === 'month') {
    let y = parseInt(from.slice(0, 4));
    let m = parseInt(from.slice(5, 7));
    const endY = parseInt(to.slice(0, 4));
    const endM = parseInt(to.slice(5, 7));
    while (y < endY || (y === endY && m <= endM)) {
      result.push({ label: `${MONTHS[m - 1]} ${y}`, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-31` });
      if (++m > 12) { m = 1; y++; }
    }
  } else if (range === 'quarter') {
    let y = parseInt(from.slice(0, 4));
    let q = Math.floor((parseInt(from.slice(5, 7)) - 1) / 3) + 1;
    const endY = parseInt(to.slice(0, 4));
    const endQ = Math.floor((parseInt(to.slice(5, 7)) - 1) / 3) + 1;
    while (y < endY || (y === endY && q <= endQ)) {
      result.push({ label: `Q${q} ${y}`, from: `${y}-${Q_FROM[q - 1]}-01`, to: `${y}-${Q_TO[q - 1]}-31` });
      if (++q > 4) { q = 1; y++; }
    }
  } else if (range === 'year') {
    let y = parseInt(from.slice(0, 4));
    const endY = parseInt(to.slice(0, 4));
    while (y <= endY) {
      result.push({ label: `${y}`, from: `${y}-01-01`, to: `${y}-12-31` });
      y++;
    }
  } else {
    let current = from;
    while (current <= to) {
      const end = addDays(current, 6);
      result.push({ label: weekLabel(current, end), from: current, to: end });
      current = addDays(current, 7);
    }
  }
  return result;
}

export type DriftWindows = {
  current:    { from: string; to: string };
  lastPeriod: { from: string; to: string };
  lastYear:   { from: string; to: string };
  rolling12:  Array<{ from: string; to: string }>; // 12 complete periods, newest first
};

/**
 * Compute comparison windows for drift mode.
 * All windows are capped to the same number of elapsed days as the current period
 * so partial-month comparisons are fair (e.g., first 15 days vs first 15 days).
 * Returns null for alltime (no meaningful comparison).
 */
export function getDriftWindows(range: Range, anchor: Date, today: Date): DriftWindows | null {
  if (range === 'alltime') return null;

  const { from, to } = getPeriodDates(range, anchor);
  const todayStr   = toStr(today);
  const effectiveTo = to > todayStr ? todayStr : to;

  // Days elapsed in current period (0-based offset: May 1→May 27 = 26)
  const elapsedDays = Math.round(
    (new Date(effectiveTo + 'T12:00:00').getTime() - new Date(from + 'T12:00:00').getTime()) / 86400000,
  );

  // Build a window starting at startStr, extending elapsedDays forward, capped at maxEnd
  function mkWindow(startStr: string, maxEnd: string): { from: string; to: string } {
    const end = new Date(startStr + 'T12:00:00');
    end.setDate(end.getDate() + elapsedDays);
    const endStr = toStr(end);
    return { from: startStr, to: endStr <= maxEnd ? endStr : maxEnd };
  }

  // Last period
  const lastAnchor = navigatePeriod(range, anchor, -1);
  const lastFull   = getPeriodDates(range, lastAnchor);
  const lastPeriod = mkWindow(lastFull.from, lastFull.to);

  // Same period last year — weeks use 52-week offset to preserve day-of-week
  let lyAnchor: Date;
  if (range === 'week') {
    lyAnchor = new Date(anchor);
    lyAnchor.setDate(lyAnchor.getDate() - 364);
  } else {
    lyAnchor = new Date(anchor);
    lyAnchor.setFullYear(anchor.getFullYear() - 1);
  }
  const lyFull   = getPeriodDates(range, lyAnchor);
  const lastYear = mkWindow(lyFull.from, lyFull.to);

  // Rolling 12: last 12 complete periods before current
  const rolling12: Array<{ from: string; to: string }> = [];
  let rollAnchor = navigatePeriod(range, anchor, -1);
  for (let i = 0; i < 12; i++) {
    const p = getPeriodDates(range, rollAnchor);
    rolling12.push(mkWindow(p.from, p.to));
    rollAnchor = navigatePeriod(range, rollAnchor, -1);
  }

  return { current: { from, to: effectiveTo }, lastPeriod, lastYear, rolling12 };
}

export function formatPeriodLabel(range: Range, anchor: Date): string {
  switch (range) {
    case 'week': {
      const end = new Date(anchor); end.setDate(anchor.getDate() + 6);
      const sameYear = anchor.getFullYear() === end.getFullYear();
      const sameMonth = anchor.getMonth() === end.getMonth();
      if (sameMonth) return `${MONTHS[anchor.getMonth()]} ${anchor.getDate()}–${end.getDate()}, ${anchor.getFullYear()}`;
      if (sameYear)  return `${MONTHS[anchor.getMonth()]} ${anchor.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}, ${anchor.getFullYear()}`;
      return `${MONTHS[anchor.getMonth()]} ${anchor.getDate()} – ${MONTHS[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    }
    case 'month':   return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
    case 'quarter': return `Q${Math.floor(anchor.getMonth() / 3) + 1} ${anchor.getFullYear()}`;
    case 'year':    return `${anchor.getFullYear()}`;
    case 'alltime': return 'All Time';
  }
}
