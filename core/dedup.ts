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
  )
`;

export async function getCsvPlaidDupeCandidates(): Promise<DupePair[]> {
  const result = await db.execute(`
    SELECT csv.id as csvId, csv.date as csvDate, csv.name as csvName, csv.amount as csvAmount,
           plaid.date as plaidDate, plaid.name as plaidName,
           a.name as accountName
    FROM transactions csv
    JOIN transactions plaid ON ${MATCH_SQL}
    JOIN accounts a ON a.id = csv.account_id
    ORDER BY csv.date DESC
  `);
  return result.rows as unknown as DupePair[];
}

export async function deduplicateCsvVsPlaid(): Promise<number> {
  const result = await db.execute(`
    SELECT csv.id as csv_id
    FROM transactions csv
    JOIN transactions plaid ON ${MATCH_SQL}
  `);
  const csvDupes = result.rows as unknown as { csv_id: string }[];
  if (csvDupes.length === 0) return 0;

  const ids = csvDupes.map((r) => r.csv_id);
  const placeholders = ids.map(() => '?').join(',');
  const del = await db.execute({
    sql: `DELETE FROM transactions WHERE id IN (${placeholders})`,
    args: ids,
  });
  return del.rowsAffected;
}
