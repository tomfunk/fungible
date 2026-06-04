import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { parseDate, generateTxId } from './csv.js';
import type { CsvAccount } from './queries.js';

export async function updateAccountTypeSubtype(id: string, type: string, subtype: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET type = ?, subtype = ? WHERE id = ?', args: [type, subtype, id] });
}

export async function updateAccountNickname(id: string, nickname: string | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET nickname = ? WHERE id = ?', args: [nickname, id] });
}

export async function updateAccountApr(id: string, apr: number | null): Promise<void> {
  await db.execute({ sql: 'UPDATE accounts SET apr = ? WHERE id = ?', args: [apr, id] });
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
): Promise<{ imported: number; skipped: number }> {
  const { amountMode, dateCol, nameCol, amountCol, debitCol, creditCol, positiveIsInflow } = cfg;
  const rules = await loadCategoryRules();

  let imported = 0, skipped = 0;
  for (const row of csvRows) {
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
    if (!rawDate || !name || isNaN(amount)) { skipped++; continue; }
    const date = parseDate(rawDate);
    const category = categorizeWithRules(rules, name, null, null);
    const id = generateTxId(account.mask ?? account.id, date, name, amount);
    const result = await db.execute({
      sql: 'INSERT OR IGNORE INTO transactions (id, account_id, date, name, amount, category, raw_category, pending) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)',
      args: [id, account.id, date, name, amount, category],
    });
    if (result.rowsAffected > 0) imported++; else skipped++;
  }
  return { imported, skipped };
}

export async function deleteDuplicate(csvId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM transactions WHERE id = ?', args: [csvId] });
}

export async function deleteAllDuplicates(csvIds: string[]): Promise<void> {
  if (csvIds.length === 0) return;
  const placeholders = csvIds.map(() => '?').join(',');
  await db.execute({ sql: `DELETE FROM transactions WHERE id IN (${placeholders})`, args: csvIds });
}
