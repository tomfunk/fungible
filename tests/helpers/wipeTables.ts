/** Tables the per-screen TUI tests clear between tests (order is FK-safe). */
export const SCREEN_TABLES = [
  'transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
  'category_rules', 'name_rules', 'hidden_categories', 'balance_history', 'settings',
] as const;

/** Deletes every row from SCREEN_TABLES. */
export async function wipeScreenTables(db: { execute: (sql: string) => Promise<unknown> }): Promise<void> {
  for (const tbl of SCREEN_TABLES) await db.execute(`DELETE FROM ${tbl}`);
}
