export function fmt(n: number, decimals = 2): string {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function fmtSigned(n: number, decimals = 2): string {
  return `${n >= 0 ? '+' : '-'}${fmt(n, decimals)}`;
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
