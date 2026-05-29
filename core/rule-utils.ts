import { db } from './db.js';

/** Returns true if the transaction amount is within the rule's optional range. */
export function inAmountRange(
  amount: number | undefined,
  min: number | null,
  max: number | null,
): boolean {
  if (amount === undefined) return true;
  if (min !== null && amount < min) return false;
  if (max !== null && amount > max) return false;
  return true;
}

/**
 * Validates a regex pattern and throws if invalid or causes catastrophic backtracking.
 */
export function validateRegex(pattern: string): void {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    throw new Error(`Invalid regex pattern: ${pattern}`);
  }
  const probe = 'a'.repeat(64) + '\x00';
  const start = Date.now();
  re.test(probe);
  if (Date.now() - start > 100) {
    throw new Error(`Regex pattern causes excessive backtracking and cannot be used: ${pattern}`);
  }
}

/** Count how many transactions match a pattern (name substring or regex). */
export async function countPatternMatches(pattern: string, matchType: 'name' | 'regex'): Promise<number> {
  if (!pattern) return 0;
  try {
    if (matchType === 'name') {
      const result = await db.execute({
        sql: "SELECT COUNT(*) as c FROM transactions WHERE name LIKE ? OR COALESCE(merchant_name, '') LIKE ?",
        args: [`%${pattern}%`, `%${pattern}%`],
      });
      return Number((result.rows[0] as unknown as { c: number }).c);
    }
    const re = new RegExp(pattern, 'i');
    const result = await db.execute('SELECT name, merchant_name FROM transactions');
    const rows = result.rows as unknown as { name: string; merchant_name: string | null }[];
    return rows.filter((r) => re.test(r.name) || (r.merchant_name ? re.test(r.merchant_name) : false)).length;
  } catch { return 0; }
}

/** Returns true if any haystack string matches the pattern. */
export function matchesPattern(
  pattern: string,
  matchType: 'name' | 'regex',
  haystacks: string[],
): boolean {
  if (matchType === 'name') {
    const lower = pattern.toLowerCase();
    return haystacks.some((h) => h.includes(lower));
  }
  const re = new RegExp(pattern, 'i');
  return haystacks.some((h) => re.test(h));
}
