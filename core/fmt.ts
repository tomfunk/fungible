import { MONTHS } from './dateUtils.js';

export function fmt(n: number, decimals = 2): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function fmtSigned(n: number, decimals = 2): string {
  return `${n >= 0 ? '+' : '-'}${fmt(Math.abs(n), decimals)}`;
}

export function fmtPct(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`;
}

export function fmtPctSigned(n: number, decimals = 1): string {
  return `${n >= 0 ? '+' : ''}${fmtPct(n, decimals)}`;
}

export function fmtMonths(n: number): string {
  if (!isFinite(n) || n > 999) return '∞';
  return `${n.toFixed(1)} mo`;
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)    return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${fmt(abs)}`;
}

export function fmtCompactSigned(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)    return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${fmt(abs)}`;
}

// Formats a tag's date span (ISO YYYY-MM-DD bounds) down to month granularity,
// e.g. "2024-01 → 2025-06", collapsing to a single month when they match.
export function fmtTimeAgo(ms: number | null): string {
  if (ms === null) return 'never';
  const diffMs = Date.now() - ms;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

/** Sync recency for an Accounts row: relative within a day, then a plain date.
 *  Mirrors fmtTimeAgo's null → 'never'. */
export function fmtSyncedAt(ms: number | null): string {
  if (ms === null) return 'never';
  if (Date.now() - ms < 24 * 60 * 60 * 1000) return fmtTimeAgo(ms);
  const dt = new Date(ms);
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

export function fmtSpan(earliest: string | null, latest: string | null): string {
  if (!earliest || !latest) return '—';
  const from = earliest.slice(0, 7);
  const to = latest.slice(0, 7);
  return from === to ? from : `${from} → ${to}`;
}

export type TagSort = 'name' | 'recent' | 'oldest';

export function sortTags<T extends { earliest: string | null; latest: string | null }>(
  tags: T[],
  sort: TagSort,
): T[] {
  if (sort === 'name') return tags;
  const sorted = [...tags];
  if (sort === 'recent') {
    sorted.sort((a, b) => (b.latest ?? '').localeCompare(a.latest ?? ''));
  } else {
    sorted.sort((a, b) => {
      if (!a.earliest) return 1;
      if (!b.earliest) return -1;
      return a.earliest.localeCompare(b.earliest);
    });
  }
  return sorted;
}
