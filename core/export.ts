// Transaction export (Issue #18). Kept separate from queries.ts: this file
// owns two distinct concerns -- fetching the full, uncapped row set for a
// date range/filter, and serializing it to CSV -- neither of which is a
// screen query. In particular this must NOT reuse getTransactions
// (queries.ts): that function caps results at `LIMIT 5000` in SQL and then
// `.slice(0, 200)` in JS unconditionally, which exists purely to keep the
// Transactions screen's render fast and would silently truncate an export.

import { db } from './db.js';
import { buildFilterConditions, type Filter } from './filters.js';
import { buildSearchMatcher } from './queries.js';

export type ExportFilters = {
  filter?: Filter;
  from: string;
  to: string;
  search?: string;
  // Hidden categories (e.g. "Transfer") are excluded by default, matching
  // every total/trend query in this codebase (getRangeSummary, trends.ts,
  // etc.) -- NOT the raw Transactions-screen row list, which shows every
  // category unfiltered. Pass true to include them anyway.
  includeHidden?: boolean;
};

export type ExportRow = {
  date: string;
  name: string;
  displayName: string;
  // Negated from the stored (Plaid) convention: stored positive = outflow,
  // stored negative = inflow. Export flips this so negative = expense,
  // positive = income -- the opposite of storage, matching the issue's
  // spec and how fmtTxAmount (fmt.ts) already displays amounts to people.
  amount: number;
  category: string;
  account: string;
  tags: string;
  isIgnored: boolean;
  isPending: boolean;
};

type ExportQueryRow = {
  date: string;
  name: string;
  display_name: string | null;
  merchant_name: string | null;
  amount: number;
  category: string | null;
  account: string | null;
  tag_names: string | null;
  ignored: number;
  pending: number;
};

/**
 * Fetches every transaction matching the filter, with no row cap -- the
 * export's entire reason for not reusing getTransactions. Ignored/pending
 * rows are included (flagged via isIgnored/isPending) rather than dropped:
 * this is a data-portability/safety-net feature, not a report, so nothing
 * should silently disappear from the file.
 */
export async function getExportRows(f: ExportFilters): Promise<ExportRow[]> {
  const conditions: string[] = ['t.date >= ?', 't.date <= ?'];
  const args: (string | number)[] = [f.from, f.to];

  if (!f.includeHidden) {
    conditions.push('t.category NOT IN (SELECT category FROM hidden_categories)');
  }
  const fc = buildFilterConditions(f.filter, 't');
  conditions.push(...fc.conditions);
  args.push(...fc.args);

  const where = 'WHERE ' + conditions.join(' AND ');
  const result = await db.execute({
    sql: `
      SELECT t.date, t.name, t.display_name, t.merchant_name, t.amount, t.category,
             t.ignored, t.pending,
             COALESCE(a.nickname, a.name) as account,
             (SELECT GROUP_CONCAT(tg.name, ', ') FROM transaction_tags tt
                JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = t.id) as tag_names
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      ${where}
      ORDER BY t.date ASC, t.id ASC
    `,
    args,
  });

  let rows = result.rows as unknown as ExportQueryRow[];

  if (f.search) {
    const matcher = buildSearchMatcher(f.search);
    rows = rows.filter((r) =>
      matcher.test(
        [r.display_name ?? r.merchant_name ?? r.name, !r.display_name && r.merchant_name !== null ? r.name : null],
        Number(r.amount),
        r.date,
      ),
    );
  }

  return rows.map((r) => ({
    date: r.date,
    name: r.name,
    displayName: r.display_name ?? r.merchant_name ?? r.name,
    amount: -Number(r.amount),
    category: r.category ?? '',
    account: r.account ?? '',
    tags: r.tag_names ?? '',
    isIgnored: !!Number(r.ignored),
    isPending: !!Number(r.pending),
  }));
}

const CSV_HEADER = ['date', 'name', 'display_name', 'amount', 'category', 'account', 'tags', 'is_ignored', 'is_pending'];

/** Quotes a field per RFC 4180 only when it needs it: contains a comma,
 *  double quote, or newline. Internal double quotes are doubled. */
function csvField(value: string | number | boolean): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Pure CSV serialization -- no DB access, so it's trivially unit-testable
 *  against hand-built rows. core/csv.ts only ever parses CSV (import
 *  direction); there's no existing writer to reuse. */
export function transactionsToCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([
      csvField(r.date),
      csvField(r.name),
      csvField(r.displayName),
      csvField(r.amount.toFixed(2)),
      csvField(r.category),
      csvField(r.account),
      csvField(r.tags),
      csvField(r.isIgnored),
      csvField(r.isPending),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

export async function exportTransactionsCsv(f: ExportFilters): Promise<string> {
  return transactionsToCsv(await getExportRows(f));
}
