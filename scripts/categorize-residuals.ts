/**
 * Adds rules for residual uncategorized transactions and applies them.
 * Safe to re-run — uses INSERT OR IGNORE on patterns.
 */
import 'dotenv/config';
import { initDb, db } from '../core/db.js';
import { categorize } from '../core/categorize.js';

const rules: { priority: number; match_type: 'name' | 'regex'; pattern: string; category: string }[] = [
  // ── European POS systems (Zettle = PayPal's Square, SumUp, WEIQ) ──────────
  { priority: 9, match_type: 'regex', pattern: '^Zettle_\\*', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: '^ZETTLE_\\*', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: '^SumUp\\s*\\*', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: '^WEIQ\\s', category: 'Food & Drink' },

  // ── Food chains / cafes ───────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'IKEA.*REST', category: 'Food & Drink' },
  { priority: 9, match_type: 'name',  pattern: '85C BAKERY', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'KRISPY KREME', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'PROTEIN BAR', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'MOONLITE BARBQ', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'CHEESE BOARD', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Meadowlark Dairy', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'HMS Host', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'LEVY@', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: '365 MARKET', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Bxl Food', category: 'Food & Drink' },
  { priority: 9, match_type: 'name',  pattern: 'Swig', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'SKYLINE.*NICHOLA', category: 'Food & Drink' },

  // ── Canadian food (Montreal) ──────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'ST-VIATEUR BAGEL', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'LA BANQUISE', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'OLIVE & GOURMANDO', category: 'Food & Drink' },

  // ── Debit card purchases at food places (Capital One format) ─────────────
  { priority: 8, match_type: 'regex', pattern: 'Debit Card Purchase.*FOOD', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: 'Debit Card Purchase.*BAKERI', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: 'Debit Card Purchase.*KAFE', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: 'Debit Card Purchase.*SHELL', category: 'Transportation' },

  // ── Personal Care ─────────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'MASSAGE CENTER', category: 'Personal Care' },

  // ── Bills & Utilities ─────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'GOOGLE.*Google One', category: 'Bills & Utilities' },

  // ── Transfers / Refunds ───────────────────────────────────────────────────
  { priority: 10, match_type: 'regex', pattern: 'CASH BACK', category: 'Income' },
  { priority: 10, match_type: 'regex', pattern: 'Refund Globalblue', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'support@keeperta', category: 'Transfer' },
  { priority: 10, match_type: 'regex', pattern: 'GUSTO ACCTVERIFY', category: 'Transfer' },

  // ── Taxes / Government ────────────────────────────────────────────────────
  { priority: 9, match_type: 'name',  pattern: 'FRANCHISE TAX BD', category: 'Taxes' },
  { priority: 9, match_type: 'regex', pattern: 'OV PTA', category: 'Government' },

  // ── Travel (hotels, B&Bs) ─────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'BLUE DOOR INNS', category: 'Travel' },
  { priority: 9, match_type: 'regex', pattern: '^BCK\\*', category: 'Travel' },

  // ── Transportation ────────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*GAS', category: 'Transportation' },
  { priority: 9, match_type: 'regex', pattern: 'GASOLINE', category: 'Transportation' },
  { priority: 9, match_type: 'regex', pattern: '^AGENT FEE\\s', category: 'Bills & Utilities' },

  // ── Shopping ──────────────────────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'WHSMITH', category: 'Shopping' },
  { priority: 9, match_type: 'regex', pattern: 'CRAIGSLIST', category: 'Services' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*NETTO', category: 'Food & Drink' },

  // ── Professional / Education ──────────────────────────────────────────────
  { priority: 9, match_type: 'regex', pattern: 'CFA Institute', category: 'Services' },

  // ── Food — specific chains & one-off international spots ──────────────────
  { priority: 9, match_type: 'regex', pattern: 'CAFE RIO', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'CAFE ZUPAS', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'CACTUS TACO', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: "AMYS DRIVE THRU", category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'ARMK', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Eataly', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'McDonalds|Mc Donalds', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'DELI DEL TORO', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'MASTER KEBAB', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'AMS Cheese', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'VILLAGE BAKER', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'JULIES KITCHEN', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'MARKET STREET GRILL', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Winkel43', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Konditor bager', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'LAGKAGEHUSET', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'EMMERYS', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'BAKER BRUN', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'JOE.*JUICE', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Deliway Rail', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*RESTAURANT', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*CAFE', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*WAFFLE', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*KEBAB', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*GRILL', category: 'Food & Drink' },
  { priority: 9, match_type: 'regex', pattern: 'Debit Card Purchase.*BAKERY', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: '\\bBROD\\b|\\bBRED\\b|\\bBAEKERI\\b|\\bBAGERI\\b', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: 'GATEAU', category: 'Food & Drink' },
  { priority: 8, match_type: 'regex', pattern: 'BBROOD', category: 'Food & Drink' },
];

async function main() {
  await initDb();

  let added = 0;
  for (const r of rules) {
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO category_rules (priority, match_type, pattern, category) VALUES (?, ?, ?, ?)`,
      args: [r.priority, r.match_type, r.pattern, r.category],
    });
    if (result.rowsAffected) added++;
  }
  console.log(`Added ${added} new rules.`);

  const uncategorizedResult = await db.execute(
    `SELECT id, name, merchant_name FROM transactions WHERE category = 'Uncategorized'`
  );
  const uncategorized = uncategorizedResult.rows as unknown as {
    id: string; name: string; merchant_name: string | null;
  }[];

  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const tx of uncategorized) {
    const cat = await categorize(tx.name, tx.merchant_name, null);
    if (cat !== 'Uncategorized') {
      updates.push({ sql: 'UPDATE transactions SET category = ? WHERE id = ?', args: [cat, tx.id] });
    }
  }
  if (updates.length > 0) await db.batch(updates, 'write');
  console.log(`Recategorized ${updates.length} of ${uncategorized.length} transactions.`);

  const remainingResult = await db.execute(`
    SELECT name, COUNT(*) as count
    FROM transactions WHERE category = 'Uncategorized'
    GROUP BY name ORDER BY count DESC
  `);
  const remaining = remainingResult.rows as unknown as { name: string; count: number }[];

  if (remaining.length === 0) {
    console.log('\nAll transactions categorized!');
  } else {
    console.log(`\n${remaining.length} names still uncategorized:`);
    remaining.forEach((r) => console.log(`  ${String(r.count).padStart(3)}x  ${r.name}`));
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
