export function fmt(n: number, decimals = 2): string {
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function fmtSigned(n: number, decimals = 2): string {
  return `${n >= 0 ? '+' : '-'}${fmt(n, decimals)}`;
}

export function fmtPct(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`;
}

export function fmtMonths(n: number): string {
  if (!isFinite(n) || n > 999) return '∞';
  return `${n.toFixed(1)} mo`;
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)    return `$${(abs / 1_000).toFixed(1)}K`;
  return fmt(n);
}
