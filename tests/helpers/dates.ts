/**
 * UTC yyyy-mm-dd for `n` days before `from` (default: now). Matches how
 * balance_history writers store dates (`new Date().toISOString().slice(0, 10)`),
 * so a seeded row is exactly `n` calendar days old under the UTC convention.
 */
export function isoDaysAgo(n: number, from: Date = new Date()): string {
  return new Date(from.getTime() - n * 86_400_000).toISOString().slice(0, 10);
}
