import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { applyTagRules } from './tag-rules.js';
import { parseDate, assignOrdinals, dedupKey } from './csv.js';
import { openImport, closeImport, importTxId } from './imports.js';
import type { CsvAccount } from './queries.js';

export async function updateAccountTypeSubtype(id: string, type: string, subtype: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET type = ?, subtype = ? WHERE id = ?', args: [type, subtype, id] });
}

export async function updateAccountNickname(id: string, nickname: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET nickname = ? WHERE id = ?', args: [nickname, id] });
}

export async function updateAccountOwner(id: string, owner: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET owner = ? WHERE id = ?', args: [owner, id] });
}

export async function updateAccountApr(id: string, apr: number | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET apr = ? WHERE id = ?', args: [apr, id] });
}

export async function updateAccountExcluded(id: string, excluded: boolean): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET excluded = ? WHERE id = ?', args: [excluded ? 1 : 0, id] });
}

export async function updateAccountValue(id: string, value: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db.execute({
    sql: 'INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)',
    args: [id, value, today],
  });
}

export async function createCsvAccount(name: string, type: string, subtype: string | null): Promise<string> {
  const id = `csv-acct-${Date.now()}`;
  await db.execute({ sql: 'INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)', args: [id, name.trim(), type, subtype] });
  return id;
}

export async function createManualAccount(name: string, value: number): Promise<string> {
  const id = `manual-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  await db.batch([
    { sql: 'INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)', args: [id, name.trim(), 'other', 'manual'] },
    { sql: 'INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)', args: [id, value, today] },
  ], 'write');
  return id;
}

export async function deleteAccount(id: string): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)', args: [id] },
    { sql: 'DELETE FROM transactions WHERE account_id = ?', args: [id] },
    { sql: 'DELETE FROM balance_history WHERE account_id = ?', args: [id] },
    { sql: 'DELETE FROM category_rules WHERE account_id = ?', args: [id] },
    { sql: 'DELETE FROM name_rules WHERE account_id = ?', args: [id] },
    // The transactions they described are gone with the account, so the import
    // records would only ever report zero rows present.
    { sql: 'DELETE FROM imports WHERE account_id = ?', args: [id] },
    { sql: 'DELETE FROM accounts WHERE id = ?', args: [id] },
  ], 'write');
}

export type ImportConfig = {
  amountMode: 'single' | 'split';
  dateCol: number;
  nameCol: number;
  amountCol: number | null;
  debitCol: number | null;
  creditCol: number | null;
  positiveIsInflow: boolean;
};

export async function importCsvTransactions(
  csvRows: string[][],
  account: CsvAccount,
  cfg: ImportConfig,
  file: { name: string; hash: string },
): Promise<{ imported: number; skipped: number; importId: number }> {
  const { amountMode, dateCol, nameCol, amountCol, debitCol, creditCol, positiveIsInflow } = cfg;
  const rules = await loadCategoryRules();

  // Parse the whole file before writing anything: ordinals are an occurrence
  // count across the file, so they cannot be assigned row by row. `rowIndex` is
  // the row's position in the file and becomes part of its transaction id, which
  // keeps an id traceable back to the line it came from.
  const parsed: { rowIndex: number; date: string; name: string; amount: number }[] = [];
  let skipped = 0;
  csvRows.forEach((row, rowIndex) => {
    const rawDate = row[dateCol] ?? '';
    const name = row[nameCol] ?? '';
    let amount: number;
    if (amountMode === 'split') {
      const debit  = parseFloat(row[debitCol!]  || '0') || 0;
      const credit = parseFloat(row[creditCol!] || '0') || 0;
      amount = debit > 0 ? debit : -credit;
    } else {
      const raw = parseFloat(row[amountCol!] || '0') || 0;
      amount = positiveIsInflow ? -raw : raw;
    }
    if (!rawDate || !name || isNaN(amount)) { skipped++; return; }
    parsed.push({ rowIndex, date: parseDate(rawDate), name, amount });
  });

  // Opened before the rows, because its id is part of every transaction id.
  const importId = await openImport(account.id, file.name, file.hash, csvRows.length, cfg);

  let imported = 0;
  let minDate: string | null = null, maxDate: string | null = null;
  const newIds: string[] = [];
  for (const row of assignOrdinals(parsed)) {
    const category = categorizeWithRules(rules, row.name, null, null, row.amount, account.id);
    const id = importTxId(importId, row.rowIndex);
    // OR IGNORE covers the unique index on (account_id, dedup_key): a row this
    // account already holds — from an overlapping statement, or a re-import of
    // this same file — is skipped rather than duplicated.
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO transactions
              (id, account_id, date, name, amount, category, raw_category, pending, source, import_id, dedup_key)
            VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 'csv', ?, ?)`,
      args: [id, account.id, row.date, row.name, row.amount, category, importId,
             dedupKey(row.date, row.name, row.amount, row.ord)],
    });
    if (result.rowsAffected > 0) {
      imported++;
      newIds.push(id);
      if (minDate === null || row.date < minDate) minDate = row.date;
      if (maxDate === null || row.date > maxDate) maxDate = row.date;
    } else skipped++;
  }

  await closeImport(importId, { imported, skipped, minDate, maxDate });
  // Tag only genuinely new rows so a tag a user removed never returns.
  await applyTagRules({ txIds: newIds });
  return { imported, skipped, importId };
}

export async function deleteDuplicate(csvId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [csvId] });
}

export async function deleteAllDuplicates(csvIds: string[]): Promise<void> {
  if (csvIds.length === 0) return;
  const placeholders = csvIds.map(() => '?').join(',');
  await db.execute({ sql: `DELETE FROM transactions WHERE id IN (${placeholders})`, args: csvIds });
}
