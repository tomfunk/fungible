import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initDb, db } from '../core/db.js';
import { categorize } from '../core/categorize.js';
import { deduplicateCsvVsPlaid } from '../core/dedup.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function parseDate(raw: string): string {
  // MM/DD/YY → YYYY-MM-DD
  if (raw.includes('/')) {
    const [m, d, y] = raw.split('/');
    const fullYear = parseInt(y) < 50 ? `20${y}` : `19${y}`;
    return `${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return raw; // already YYYY-MM-DD
}

function txId(accountMask: string, date: string, description: string, amount: number): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${accountMask}|${date}|${description.trim().toLowerCase()}|${amount}`)
    .digest('hex')
    .slice(0, 16);
  return `csv-${hash}`;
}

async function ensureAccount(mask: string, name: string, type: string, subtype: string): Promise<string> {
  const result = await db.execute({ sql: 'SELECT id FROM accounts WHERE mask = ?', args: [mask] });
  const existing = result.rows[0] as unknown as { id: string } | undefined;
  if (existing) return existing.id;

  const id = `csv-acct-${mask}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO accounts (id, name, type, subtype, institution_name, mask)
          VALUES (?, ?, ?, ?, 'Capital One', ?)`,
    args: [id, name, type, subtype, mask],
  });
  return id;
}

// Capital One CSV category → our category
const CAP_ONE_CATEGORY_MAP: Record<string, string> = {
  'Gas/Automotive':       'Transportation',
  'Automotive':           'Transportation',
  'Phone/Cable':          'Bills & Utilities',
  'Utilities':            'Bills & Utilities',
  'Cable/Satellite Svcs': 'Bills & Utilities',
  'Merchandise':          'Shopping',
  'Clothing':             'Shopping',
  'Electronics':          'Shopping',
  'Groceries':            'Food & Drink',
  'Restaurants':          'Food & Drink',
  'Food & Drink':         'Food & Drink',
  'Travel':               'Travel',
  'Airlines':             'Travel',
  'Hotel':                'Travel',
  'Entertainment':        'Entertainment',
  'Movies/Music':         'Entertainment',
  'Healthcare/Medical':   'Medical',
  'Pharmacy':             'Medical',
  'Personal Care':        'Personal Care',
  'Home Improvement':     'Home',
  'Furnishings':          'Home',
  'Payment/Credit':       'Transfer',
  'Transfer':             'Transfer',
  'Fees/Interest':        'Fees',
  'Other Services':       'Services',
  'Other Travel':         'Travel',
  'Streaming':            'Entertainment',
  'Subscription':         'Services',
};

function mapCapOneCategory(raw: string): string | null {
  return CAP_ONE_CATEGORY_MAP[raw.trim()] ?? null;
}

// ── parsers ───────────────────────────────────────────────────────────────────

async function parseCheckingOrSavings(filePath: string): Promise<number> {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(1);
  const inserts: { sql: string; args: (string | number | null)[] }[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const [acctNum, description, rawDate, txType, rawAmount] = line.split(',');
    const mask = acctNum.trim();
    const date = parseDate(rawDate.trim());
    const name = description.trim();
    const absAmount = parseFloat(rawAmount.trim());
    const amount = txType.trim().toLowerCase() === 'credit' ? -absAmount : absAmount;

    const accountId = await ensureAccount(mask, guessAccountName(filePath, mask), 'depository', guessSubtype(filePath));
    const category = await categorize(name, null, null);
    const id = txId(mask, date, name, amount);

    inserts.push({
      sql: 'INSERT OR IGNORE INTO transactions (id, account_id, date, name, amount, category, raw_category, pending) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      args: [id, accountId, date, name, amount, category, null],
    });
  }

  if (inserts.length > 0) await db.batch(inserts, 'write');
  return inserts.length;
}

async function parseCreditCard(filePath: string): Promise<number> {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(1);
  let count = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.match(/^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]*),([^,]*)$/);
    if (!cols) continue;

    const txDate = parseDate(cols[1].trim());
    const cardMask = cols[3].trim();
    const txName = cols[4].trim();
    const rawCapOneCategory = cols[5].trim();
    const txDebit = parseFloat(cols[6].trim() || '0') || 0;
    const txCredit = parseFloat(cols[7].trim() || '0') || 0;
    const amount = txDebit > 0 ? txDebit : -txCredit;

    const accountId = await ensureAccount(cardMask, `Credit Card ${cardMask}`, 'credit', 'credit card');
    const mapped = mapCapOneCategory(rawCapOneCategory);
    const category = mapped ?? await categorize(txName, null, null);
    const id = txId(cardMask, txDate, txName, amount);

    const result = await db.execute({
      sql: 'INSERT OR IGNORE INTO transactions (id, account_id, date, name, amount, category, raw_category, pending) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      args: [id, accountId, txDate, txName, amount, category, rawCapOneCategory],
    });
    // if row already existed (Plaid dupe), update its category if it was uncategorized
    if (result.rowsAffected === 0 && mapped) {
      await db.execute({
        sql: 'UPDATE transactions SET category = ?, raw_category = ? WHERE id = ?',
        args: [category, rawCapOneCategory, id],
      });
    }
    count++;
  }

  return count;
}

function guessAccountName(filePath: string, mask: string): string {
  const base = path.basename(filePath);
  if (base.includes('JointChecking')) return 'Joint Checking';
  if (base.includes('JointSavings')) return 'Joint Savings';
  if (base.includes('SlushFund')) return 'Slush Fund';
  return `Account ${mask}`;
}

function guessSubtype(filePath: string): string {
  const base = path.basename(filePath);
  return base.toLowerCase().includes('saving') ? 'savings' : 'checking';
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  await initDb();

  const dir = process.argv[2] ?? process.cwd();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));

  let total = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const isCreditCard = file.includes('transaction_download');
    const count = isCreditCard ? await parseCreditCard(filePath) : await parseCheckingOrSavings(filePath);
    console.log(`  ${file}: ${count} rows`);
    total += count;
  }

  const removed = await deduplicateCsvVsPlaid();

  const countResult = await db.execute('SELECT COUNT(*) as c FROM transactions');
  const totalCount = (countResult.rows[0] as unknown as { c: number }).c;

  console.log(`\nImported up to ${total} rows`);
  if (removed > 0) console.log(`Removed ${removed} CSV rows that duplicated Plaid data`);
  console.log(`Total: ${totalCount}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
