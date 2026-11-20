import { db } from './db.js';

export interface TransactionDetail {
  id: string;
  accountName: string;
  accountMask: string | null;
  /** Plaid institution name; null for csv/manual accounts. */
  institution: string | null;
  /** Raw bank description (transactions.name). */
  name: string;
  merchantName: string | null;
  displayName: string | null;
  pending: boolean;
  source: 'plaid' | 'csv' | 'manual' | null;
  importFile: string | null;
  /** ISO string converted from imports.imported_at (epoch ms). */
  importedAt: string | null;
}

interface DetailRow {
  id: string;
  account_name: string;
  mask: string | null;
  institution: string | null;
  name: string;
  merchant_name: string | null;
  display_name: string | null;
  pending: number;
  source: string | null;
  import_file: string | null;
  imported_at: number | null;
}

/** Read-only detail for one transaction; null when the id is unknown. */
export async function getTransactionDetail(id: string): Promise<TransactionDetail | null> {
  const res = await db.execute({
    sql: `SELECT t.id, COALESCE(a.nickname, a.name) AS account_name, a.mask,
                 pi.institution_name AS institution,
                 t.name, t.merchant_name, t.display_name, t.pending, t.source,
                 i.file_name AS import_file, i.imported_at
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          LEFT JOIN plaid_items pi ON pi.item_id = a.item_id
          LEFT JOIN imports i ON i.id = t.import_id
          WHERE t.id = ?`,
    args: [id],
  });
  const r = res.rows[0] as unknown as DetailRow | undefined;
  if (!r) return null;
  const ms = r.imported_at == null ? null : Number(r.imported_at);
  return {
    id: r.id,
    accountName: r.account_name ?? '',
    accountMask: r.mask ?? null,
    institution: r.institution ?? null,
    name: r.name,
    merchantName: r.merchant_name ?? null,
    displayName: r.display_name ?? null,
    pending: !!r.pending,
    source: (r.source as TransactionDetail['source']) ?? null,
    importFile: r.import_file ?? null,
    importedAt: ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString(),
  };
}
