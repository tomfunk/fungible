import type { AccountBalance } from './queries.js';

// Pure account-grouping helpers, split out of queries.ts so the browser (gui
// renderer) bundle can import them without pulling in db.ts (and its
// transitive Node-only deps like crypto.ts) -- queries.ts re-exports these
// for existing `from './queries.js'` importers (tui).

export type TypeBalance = { label: string; balance: number };

/** Group accounts by (subtype ?? type), labeled via the caller-supplied
 *  `typeLabel` (each UI's own SUBTYPE_DISPLAY lookup stays there), summed by
 *  balance and sorted descending. Ported from gui/tui NetWorth.tsx's
 *  identical local groupByType. */
export function groupAccountsByType(accs: AccountBalance[], typeLabel: (raw: string) => string): TypeBalance[] {
  const map = new Map<string, number>();
  for (const a of accs) {
    const raw = a.subtype ?? a.type;
    const key = typeLabel(raw);
    map.set(key, (map.get(key) ?? 0) + a.balance);
  }
  return [...map.entries()]
    .map(([label, balance]) => ({ label, balance }))
    .sort((a, b) => b.balance - a.balance);
}

/** Same grouping as groupAccountsByType, but returns the account ids per
 *  group instead of a summed balance -- used to filter transactions by the
 *  clicked type slice. Ported from gui/tui NetWorth.tsx's buildTypeToIds. */
export function buildTypeToAccountIds(accs: AccountBalance[], typeLabel: (raw: string) => string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const a of accs) {
    const key = typeLabel(a.subtype ?? a.type);
    const existing = map.get(key);
    if (existing) existing.push(a.id); else map.set(key, [a.id]);
  }
  return map;
}
