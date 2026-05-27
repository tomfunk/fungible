import { db } from './db.js';
import { categorize } from './categorize.js';
import { parseDate, generateTxId } from './csv.js';
import type { CsvAccount } from './queries.js';

export function updateAccountTypeSubtype(id: string, type: string, subtype: string | null): void {
  db.prepare('UPDATE accounts SET type = ?, subtype = ? WHERE id = ?').run(type, subtype, id);
}

export function updateAccountNickname(id: string, nickname: string | null): void {
  db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(nickname, id);
}

export function updateAccountValue(id: string, value: number): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)').run(id, value, today);
}

export function createManualAccount(name: string, value: number): string {
  const id = `manual-${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)').run(id, name.trim(), 'other', 'manual');
  db.prepare('INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)').run(id, value, today);
  return id;
}

export function deleteAccount(id: string): void {
  db.prepare('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)').run(id);
  db.prepare('DELETE FROM transactions WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM balance_history WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
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

export function importCsvTransactions(
  csvRows: string[][],
  account: CsvAccount,
  cfg: ImportConfig,
): { imported: number; skipped: number } {
  const { amountMode, dateCol, nameCol, amountCol, debitCol, creditCol, positiveIsInflow } = cfg;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, account_id, date, name, amount, category, raw_category, pending)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
  `);
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
    const category = categorize(name, null, null);
    const id = generateTxId(account.mask ?? account.id, date, name, amount);
    const changes = (insert.run(id, account.id, date, name, amount, category) as any).changes;
    if (changes > 0) imported++; else skipped++;
  }
  return { imported, skipped };
}

export function deleteDuplicate(csvId: string): void {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(csvId);
}

export function deleteAllDuplicates(csvIds: string[]): void {
  if (csvIds.length === 0) return;
  const placeholders = csvIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...csvIds);
}
