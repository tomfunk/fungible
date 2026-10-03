import type { Client } from '@libsql/client';
import { isoDaysAgo } from './dates.js';

export type SeedAccountOpts = {
  /** Account id. Manual accounts are conventionally `manual-*`; getBalanceAge keys off that prefix. */
  id: string;
  /** Plaid account type, e.g. 'depository', 'investment', 'other'. Default 'depository'. */
  type?: string;
  subtype?: string | null;
  name?: string;
  /** Age in days of the latest balance_history row. Omit for no balance row at all. */
  balanceDaysAgo?: number;
  balance?: number;
  /** Date base for balanceDaysAgo (pass a fixed Date if not using useFixedClock). */
  from?: Date;
};

async function insertAccount(db: Client, o: SeedAccountOpts, itemId: string | null) {
  await db.execute({
    sql: 'INSERT INTO accounts (id, name, type, subtype, item_id) VALUES (?, ?, ?, ?, ?)',
    args: [o.id, o.name ?? o.id, o.type ?? 'depository', o.subtype === undefined ? 'checking' : o.subtype, itemId],
  });
  if (o.balanceDaysAgo !== undefined) {
    await db.execute({
      sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)',
      args: [o.id, o.balance ?? 1000, isoDaysAgo(o.balanceDaysAgo, o.from)],
    });
  }
}

/** Manual account: id must start with 'manual-' (prefixed for you if not), no item_id. */
export async function seedManualAccount(db: Client, o: SeedAccountOpts): Promise<void> {
  const id = o.id.startsWith('manual-') ? o.id : `manual-${o.id}`;
  await insertAccount(db, { ...o, id }, null);
}

/** CSV-imported account: no item_id, id NOT prefixed 'manual-'. */
export async function seedCsvAccount(db: Client, o: SeedAccountOpts): Promise<void> {
  if (o.id.startsWith('manual-')) throw new Error(`seedCsvAccount: id "${o.id}" would classify as manual`);
  await insertAccount(db, o, null);
}

/** Plaid-linked account: creates a plaid_items row (itemId default `item-<id>`) and links it. */
export async function seedPlaidAccount(db: Client, o: SeedAccountOpts & { itemId?: string; lastSyncedAt?: number }): Promise<void> {
  const itemId = o.itemId ?? `item-${o.id}`;
  await db.execute({
    sql: 'INSERT OR IGNORE INTO plaid_items (item_id, access_token, institution_name, last_synced_at, days_requested) VALUES (?, ?, ?, ?, ?)',
    args: [itemId, 'tok', 'Test Bank', o.lastSyncedAt ?? Date.now(), 90],
  });
  await insertAccount(db, o, itemId);
}
