import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env'), quiet: true });

import { initDb, db } from '../core/db.js';
import { getPlaidClient, plaidErrorMessage } from '../core/plaid.js';
import { decryptToken } from '../core/crypto.js';

/**
 * Dev helper for verifying that updating a Plaid link re-authorizes the
 * existing Item instead of creating a second one.
 *
 * Sandbox only, and it refuses to run anywhere else: `--break` deliberately
 * invalidates an Item's login so the update flow has something to fix.
 *
 *   node --import tsx/esm scripts/sandbox-relink-check.ts            # snapshot
 *   node --import tsx/esm scripts/sandbox-relink-check.ts --break    # force re-auth
 *
 * Take a snapshot, break the item, then update it in the TUI with [u] on the
 * Links tab and snapshot again: every count should be identical. A new item,
 * account or transaction total means the update created a fresh Item rather
 * than re-authorizing the old one.
 */

type ItemRow = { item_id: string; access_token: string; institution_name: string | null };

async function snapshot(): Promise<void> {
  const items = (await db.execute(
    'SELECT item_id, institution_name, days_requested FROM plaid_items ORDER BY item_id',
  )).rows as unknown as { item_id: string; institution_name: string | null; days_requested: number | null }[];

  const counts = (await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM plaid_items)   AS items,
      (SELECT COUNT(*) FROM accounts)      AS accounts,
      (SELECT COUNT(*) FROM transactions)  AS transactions
  `)).rows[0] as unknown as { items: number; accounts: number; transactions: number };

  console.log(`\nItems: ${counts.items}  ·  Accounts: ${counts.accounts}  ·  Transactions: ${counts.transactions}`);
  for (const item of items) {
    const perItem = (await db.execute({
      sql: `SELECT COUNT(*) AS n FROM accounts WHERE item_id = ?`,
      args: [item.item_id],
    })).rows[0] as unknown as { n: number };
    console.log(
      `  ${item.item_id}  ${item.institution_name ?? '(unnamed)'}` +
      `  — ${perItem.n} account(s), days_requested=${item.days_requested ?? 'default'}`,
    );
  }
  console.log('');
}

async function breakLogin(): Promise<void> {
  const items = (await db.execute('SELECT item_id, access_token, institution_name FROM plaid_items')).rows as unknown as ItemRow[];
  if (items.length === 0) throw new Error('No linked items — link a sandbox bank first.');

  const wanted = process.argv.find((a) => a.startsWith('--item='))?.slice('--item='.length);
  const item = wanted ? items.find((i) => i.item_id === wanted) : items[0];
  if (!item) throw new Error(`Item ${wanted} not found. Known: ${items.map((i) => i.item_id).join(', ')}`);
  if (!wanted && items.length > 1) {
    throw new Error(`Multiple items linked — pick one with --item=<id>: ${items.map((i) => i.item_id).join(', ')}`);
  }

  await getPlaidClient().sandboxItemResetLogin({ access_token: decryptToken(item.access_token) });
  console.log(`\n✓ Login invalidated for ${item.institution_name ?? item.item_id}.`);
  console.log('  The next sync will fail with ITEM_LOGIN_REQUIRED — that is expected.\n');
  console.log('  Now: open the TUI (npm run dev) → Accounts → Tab to Links → select this bank → press [u].');
  console.log('  Sign in with the sandbox credentials user_good / pass_good.');
  console.log('  Then re-run this script with no flags and compare the counts above.\n');
}

async function main() {
  const env = process.env.PLAID_ENV ?? 'sandbox';
  if (env !== 'sandbox') {
    throw new Error(`Refusing to run against PLAID_ENV="${env}" — this script is sandbox-only.`);
  }

  await initDb();
  await snapshot();
  if (process.argv.includes('--break')) await breakLogin();
}

main().catch((e) => {
  console.error('Error:', plaidErrorMessage(e));
  process.exit(1);
});
