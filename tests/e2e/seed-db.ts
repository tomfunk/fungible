// Seeds a throwaway data dir. Run as a child process by the e2e specs before
// Electron launches: core/db.ts resolves FUNGIBLE_DATA_DIR at import time, so the
// seed must happen in a process whose env already carries the temp dir — it can't
// run inside the Playwright process.
//
// Modes (first CLI arg, default "demo"):
//   demo    — the full demo dataset (scripts/seed-demo.ts), used by the screen sweep.
//   fixture — a tiny hand-written dataset with distinctive names and round amounts,
//             so specs can assert exact rendered values and a persisted write.
import { initDb, db } from '../../core/db.js';
import { seedDemo } from '../../scripts/seed-demo.js';

// Hard stop: never seed (or let a spec go on to launch against) the real data dir.
if (!process.env.FUNGIBLE_DATA_DIR) {
  throw new Error('seed-db: FUNGIBLE_DATA_DIR must be set to a throwaway directory');
}

const mode = process.argv[2] ?? 'demo';

function todayIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

async function seedFixture() {
  const today = todayIso();
  await db.batch(
    [
      { sql: `INSERT INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
        args: ['fx-checking', 'Fixture Checking', 'depository', 'checking', 'Fixture Bank', '1111'] },
      { sql: `INSERT INTO accounts (id, name, type, subtype, institution_name, mask) VALUES (?, ?, ?, ?, ?, ?)`,
        args: ['fx-credit', 'Fixture Visa', 'credit', 'credit card', 'Fixture Bank', '2222'] },
      // Plaid sign convention: positive transaction = outflow, negative = inflow;
      // a credit account's balance is the (positive) amount owed.
      ...([
        ['fx-t1', 'fx-checking', 'Quokka Market', 87.43, 'Food & Drink'],
        ['fx-t2', 'fx-credit', 'Zebra Cafe', 12.34, 'Entertainment'],
        ['fx-t3', 'fx-checking', 'Okapi Payroll', -2500, 'Income'],
        ['fx-t4', 'fx-credit', 'Mystery Vendor', 45.67, 'Uncategorized'],
      ] as const).map(([id, acct, name, amount, category]) => ({
        sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, pending, source)
              VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, 'plaid')`,
        args: [id, acct, today, name, amount, category, category],
      })),
      { sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)`,
        args: ['fx-checking', 5000, today] },
      { sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)`,
        args: ['fx-credit', 1250, today] },
    ],
    'write',
  );
}

await initDb();
if (mode === 'fixture') await seedFixture();
else await seedDemo();
