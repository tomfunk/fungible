import { db } from './db.js';

export type DupePair = {
  csvId: string;
  csvDate: string;
  csvName: string;
  csvAmount: number;
  plaidDate: string;
  plaidName: string;
  accountName: string;
};

const MATCH_SQL = `
  csv.account_id = plaid.account_id
  AND csv.amount = plaid.amount
  AND ABS(JULIANDAY(csv.date) - JULIANDAY(plaid.date)) <= 3
  AND csv.id   LIKE 'csv-%'
  AND plaid.id NOT LIKE 'csv-%'
  AND (
    csv.name = plaid.name
    OR INSTR(LOWER(csv.name),  LOWER(plaid.name))  > 0
    OR INSTR(LOWER(plaid.name), LOWER(csv.name))   > 0
    OR (
      INSTR(plaid.name, '*') >= 5
      AND LOWER(SUBSTR(csv.name,   1, INSTR(plaid.name, '*') - 1))
        = LOWER(SUBSTR(plaid.name, 1, INSTR(plaid.name, '*') - 1))
    )
    OR TRIM(REPLACE(LOWER(csv.name), '  ', ' ')) = TRIM(REPLACE(LOWER(plaid.name), '  ', ' '))
    OR INSTR(LOWER(csv.name), LOWER(SUBSTR(plaid.name, 1, MAX(1, INSTR(plaid.name || ' ', ' ') - 1)))) > 0
  )
`;

/**
 * One CSV row that *could* be the same transaction as one Plaid row. The join is
 * many-to-many by nature — a merchant you visit twice in a week produces rows
 * that all match each other on amount, name and the ±3 day window — so this is a
 * candidate, not a verdict. `pairCandidates` reduces it to a decision.
 *
 * Carries the two rowids so pairing can break ties by insertion order rather
 * than by whatever order SQLite happened to return.
 */
type Candidate = DupePair & { plaidId: string; csvRowid: number; plaidRowid: number };

// LEFT JOIN, not INNER: a CSV row whose account was deleted out from under it
// still deduplicates against Plaid the way it always has. An INNER JOIN here
// would quietly make orphaned rows undeletable.
const CANDIDATE_SQL = `
  SELECT csv.id as csvId, csv.date as csvDate, csv.name as csvName, csv.amount as csvAmount,
         plaid.id as plaidId, plaid.date as plaidDate, plaid.name as plaidName,
         csv.rowid as csvRowid, plaid.rowid as plaidRowid,
         COALESCE(a.name, '') as accountName
  FROM transactions csv
  JOIN transactions plaid ON ${MATCH_SQL}
  LEFT JOIN accounts a ON a.id = csv.account_id
`;

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How strong the name evidence is, lower being stronger. Mirrors the tiers in
 * MATCH_SQL: an exact string, the same string modulo case and whitespace, one
 * name contained in the other, and finally the loose masked-prefix and
 * first-word rules that exist to catch `AMAZON*XYZ123` style Plaid names.
 */
function nameRank(csvName: string, plaidName: string): number {
  if (csvName === plaidName) return 0;
  const c = normalize(csvName);
  const p = normalize(plaidName);
  if (c === p) return 1;
  if (c.includes(p) || p.includes(c)) return 2;
  return 3;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayGap = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

/**
 * Reduces the many-to-many candidate set to a set of one-to-one pairs: every
 * CSV row is matched to at most one Plaid row, and every Plaid row absorbs at
 * most one CSV row.
 *
 * This is the whole point of the module. Two real $5 coffees in the same week
 * match each other's rows on every criterion MATCH_SQL tests, so a naive "delete
 * every CSV row that matched something" deletes both when Plaid only reported
 * one of them — silently losing a genuine transaction. Pairing means a Plaid row
 * can only ever cancel out the single CSV row it most likely *is*, and any
 * surplus CSV rows survive as the separate purchases they are.
 *
 * Greedy assignment over candidates sorted best-first. Ranking, in order:
 *
 *   1. Name evidence, because CSV and Plaid routinely disagree about the posting
 *      date — that disagreement is the reason for the ±3 day window in the first
 *      place — but rarely about the merchant string. A same-name match three days
 *      out is better evidence than a different-name match on the same day.
 *   2. Date proximity, to settle same-strength names.
 *   3. Insertion order, so the outcome is deterministic when a file contains
 *      literally identical rows. The earliest CSV row is the one consumed.
 */
export function pairCandidates(candidates: Candidate[]): Candidate[] {
  const ranked = [...candidates].sort((x, y) =>
    nameRank(x.csvName, x.plaidName) - nameRank(y.csvName, y.plaidName) ||
    dayGap(x.csvDate, x.plaidDate) - dayGap(y.csvDate, y.plaidDate) ||
    x.csvRowid - y.csvRowid ||
    x.plaidRowid - y.plaidRowid,
  );

  const takenCsv = new Set<string>();
  const takenPlaid = new Set<string>();
  const paired: Candidate[] = [];
  for (const c of ranked) {
    if (takenCsv.has(c.csvId) || takenPlaid.has(c.plaidId)) continue;
    takenCsv.add(c.csvId);
    takenPlaid.add(c.plaidId);
    paired.push(c);
  }
  return paired;
}

async function loadPairs(): Promise<Candidate[]> {
  const result = await db.execute(CANDIDATE_SQL);
  const rows = (result.rows as unknown as Candidate[]).map((r) => ({
    ...r,
    csvAmount: Number(r.csvAmount),
    csvRowid: Number(r.csvRowid),
    plaidRowid: Number(r.plaidRowid),
  }));
  return pairCandidates(rows);
}

export async function getCsvPlaidDupeCandidates(): Promise<DupePair[]> {
  const paired = await loadPairs();
  // Newest first, insertion order within a date so the list doesn't reshuffle
  // between reads.
  paired.sort((x, y) => (x.csvDate < y.csvDate ? 1 : x.csvDate > y.csvDate ? -1 : x.csvRowid - y.csvRowid));
  return paired.map(({ csvId, csvDate, csvName, csvAmount, plaidDate, plaidName, accountName }) =>
    ({ csvId, csvDate, csvName, csvAmount, plaidDate, plaidName, accountName }));
}

export async function deduplicateCsvVsPlaid(): Promise<number> {
  const paired = await loadPairs();
  if (paired.length === 0) return 0;

  const ids = paired.map((p) => p.csvId);
  const placeholders = ids.map(() => '?').join(',');
  const del = await db.execute({
    sql: `DELETE FROM transactions WHERE id IN (${placeholders})`,
    args: ids,
  });
  return del.rowsAffected;
}
