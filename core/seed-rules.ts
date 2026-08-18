import { db } from './db.js';
import { categorize } from './categorize.js';

// Generic starter rules — common merchants and POS patterns.
// Edit scripts/seed-rules.ts to add your own personal rules.
const RULES: { priority: number; match_type: 'name' | 'regex'; pattern: string; category: string }[] = [
  // ── POS / payment processors (high-confidence category signals) ────────────
  { priority: 9, match_type: 'regex', pattern: '^TST[*\\s]', category: 'Food & Drink' },   // Toast POS
  { priority: 9, match_type: 'regex', pattern: '^SQ \\*', category: 'Food & Drink' },       // Square
  { priority: 9, match_type: 'regex', pattern: '^DD \\*', category: 'Food & Drink' },       // DoorDash

  // ── Common national merchants ─────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'STARBUCKS', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'MCDONALD', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'CHIPOTLE', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'TACO BELL', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'CHICK-FIL-A', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'SHAKE SHACK', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'IN-N-OUT', category: 'Food & Drink' },

  // ── Travel ────────────────────────────────────────────────────────────────
  { priority: 10, match_type: 'regex', pattern: '^DELTA( AIR)?\\s', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: '^UNITED\\s', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: '^AMERICAN\\s?AIR', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: '^SOUTHWEST\\s', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'HERTZ', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'ENTERPRISE.*RENT', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'AIRBNB', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'HOTELS\\.COM', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'EXPEDIA', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'UBER TRIP', category: 'Travel' },
  { priority: 10, match_type: 'regex', pattern: 'LYFT', category: 'Travel' },

  // ── Transfers (common patterns) ───────────────────────────────────────────
  { priority: 10, match_type: 'regex', pattern: 'VENMO PAYMENT', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'VENMO CASHOUT', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'Zelle money (sent|received)', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'Instant transfer (sent|received)', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'Check (Deposit|#\\d)', category: 'Transfer' },

  // ── Medical ───────────────────────────────────────────────────────────────
  { priority: 10, match_type: 'regex', pattern: '^MED\\*', category: 'Medical' },
  { priority: 9,  match_type: 'regex', pattern: 'CVS/PHARMACY', category: 'Medical' },
  { priority: 9,  match_type: 'regex', pattern: 'WALGREENS', category: 'Medical' },
  { priority: 9,  match_type: 'regex', pattern: 'RITE AID', category: 'Medical' },

  // ── Shopping ──────────────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'AMAZON', category: 'Shopping' },
  { priority: 9, match_type: 'regex', pattern: 'WALMART', category: 'Shopping' },
  { priority: 9, match_type: 'regex', pattern: 'TARGET', category: 'Shopping' },
  { priority: 9, match_type: 'regex', pattern: 'COSTCO', category: 'Shopping' },
  { priority: 9, match_type: 'regex', pattern: 'BEST BUY', category: 'Shopping' },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'NETFLIX', category: 'Subscriptions' },
  { priority: 9, match_type: 'regex', pattern: 'SPOTIFY', category: 'Subscriptions' },
  { priority: 9, match_type: 'regex', pattern: 'HULU', category: 'Subscriptions' },
  { priority: 9, match_type: 'regex', pattern: 'DISNEY\\+?', category: 'Subscriptions' },
  { priority: 9, match_type: 'regex', pattern: 'APPLE\\.COM/BILL', category: 'Subscriptions' },
  { priority: 9, match_type: 'regex', pattern: 'GOOGLE.*STORAGE', category: 'Subscriptions' },
];

export async function seedRules(): Promise<{ rules: number; recategorized: number }> {
  await db.execute('DELETE FROM category_rules');
  await db.batch(
    RULES.map((r) => ({
      sql: 'INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (?, ?, ?, ?)',
      args: [r.priority, r.match_type, r.pattern, r.category],
    })),
    'write',
  );

  // Register every category the seeded rules assign. Without this a rule can
  // file transactions under a category the pickers never offer, because those
  // read from the `categories` table.
  await db.batch(
    [...new Set(RULES.map((r) => r.category))].map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  const uncategorizedResult = await db.execute({
    sql: 'SELECT id, account_id, name, merchant_name, raw_category, amount FROM transactions WHERE category = ? AND manual_category IS NULL',
    args: ['Uncategorized'],
  });
  const uncategorized = uncategorizedResult.rows as unknown as {
    id: string; account_id: string; name: string; merchant_name: string | null; raw_category: string | null; amount: number;
  }[];

  let recategorized = 0;
  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const tx of uncategorized) {
    const cat = await categorize(tx.name, tx.merchant_name, tx.raw_category, tx.amount, tx.account_id);
    if (cat !== 'Uncategorized') {
      updates.push({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: [cat, tx.id] });
      recategorized++;
    }
  }
  if (updates.length > 0) await db.batch(updates, 'write');

  return { rules: RULES.length, recategorized };
}
