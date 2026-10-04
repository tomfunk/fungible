import { describe, it, expect, beforeEach, vi } from 'vitest';
import { seedTx } from '../../helpers/seedDb.js';

// DATA SAFETY: registry imports core/db.js, which would open the real ~/.fungible DB.
vi.mock('../../../core/db.js', async () => ({
  db: await (await import('../../helpers/makeTestDb.js')).makeTestDb(),
}));

import { db } from '../../../core/db.js';
import { registry } from '../../../gui/main/registry.js';

const win = { from: '2025-01-01', to: '2025-01-31' };
const RANGE: [string, string] = ['2025-01-01', '2025-12-31'];

beforeEach(async () => {
  for (const t of ['transactions', 'accounts', 'plaid_items', 'sync_state', 'balance_history', 'category_rules', 'settings']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

/**
 * The IPC surface is intentional (see the comment atop registry.ts): adding,
 * renaming or removing a method must be a deliberate edit of this list, because
 * the renderer addresses these by string name over the bridge.
 */
const GOLDEN: Record<string, string[]> = {
  queries: [
    'getRangeSummary', 'getFlexSummary', 'getMerchantSummary', 'getUncategorizedCount', 'getDataBounds',
    'getAccountRows', 'getOwnerRows', 'getFilterOptions', 'getCategoryDriftData', 'getFlexDriftData',
    'getAccountDriftData', 'getSearchFilteredData', 'countSearchMatches', 'getTransactions', 'getAllCategories',
    'getHiddenCategorySet', 'getNetWorthHistory', 'getAccountsWithBalances', 'getLinkedAccounts', 'getLinkedItems',
    'getImportTargets', 'getAllTags', 'getTagSummary',
  ],
  transactions: [
    'setTransactionCategory', 'clearTransactionOverride', 'setTransactionDate', 'clearTransactionDate',
    'setTransactionIgnored', 'setTransactionDisplayName', 'deleteTransaction', 'upsertCategoryRule', 'upsertNameRule',
    'setTransactionCategoryBulk', 'clearOverridesBulk', 'setIgnoredBulk', 'addTransaction', 'exportTransactionsCsv',
  ],
  tags: [
    'getTagOptions', 'getTransactionTagIds', 'getOrCreateTag', 'addTagToTransaction', 'removeTagFromTransaction',
    'addTagToTransactions', 'createTag', 'renameTag', 'deleteTag',
  ],
  rules: [
    'countPatternMatches', 'countTagRuleMatches', 'getAllRules', 'getAllNameRules', 'getAllTagRules',
    'getCategoryDetails', 'toggleHiddenCategory', 'getTotalUncategorizedCount', 'deleteCategoryRule', 'deleteNameRule',
    'saveCategoryRule', 'saveNameRule', 'saveTagRule', 'deleteTagRule', 'setCategoryFlexibility', 'createCategory',
    'deleteCategory', 'renameCategory', 'suggestRuleForTransaction',
  ],
  health: ['loadHealthData', 'yearsToFire', 'coastYears', 'getHealthHistory'],
  trends: ['buildTrendViews', 'getPeriodTotals', 'getSearchPeriodTotals', 'getSearchMatchingPeriods'],
  accounts: [
    'updateAccountTypeSubtype', 'updateAccountNickname', 'updateAccountOwner', 'updateAccountApr',
    'updateAccountExcluded', 'updateAccountValue', 'createManualAccount', 'createCsvAccount', 'deleteAccount',
    'importCsvTransactions', 'deleteDuplicate', 'deleteAllDuplicates', 'getCsvPlaidDupeCandidates', 'checkKeyHealth',
  ],
  imports: ['getImports', 'getImportsOfFile', 'getImportImpact', 'deleteImport', 'moveImport'],
  balanceImport: ['previewBalanceImport', 'commitBalanceImport'],
  categorize: ['applyCategoriesToAll'],
  profile: ['loadProfile', 'saveProfile', 'getHouseholdMembers'],
  canvas: ['loadHistory', 'deleteHistoryEntry', 'loadCurrentSpec', 'updateSpec'],
  sync: ['syncAll', 'deleteCursorAndResync', 'getStatus', 'getLastSyncedAt', 'isSyncing'],
  config: ['writeEnv'],
  settings: ['getPretaxMonthly', 'setPretaxMonthly', 'getBackupIncludeKey', 'setBackupIncludeKey'],
};

describe('registry surface (golden list)', () => {
  it('exposes exactly the namespaces listed here', () => {
    expect(Object.keys(registry).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it.each(Object.entries(GOLDEN))('%s exposes exactly the listed methods, all functions', (ns, methods) => {
    const actual = (registry as unknown as Record<string, Record<string, unknown>>)[ns];
    expect(Object.keys(actual).sort()).toEqual([...methods].sort());
    for (const m of methods) expect(typeof actual[m], `${ns}.${m}`).toBe('function');
  });
});

describe('read-only methods against an empty DB', () => {
  const q = registry.queries;
  // [label, call, expected empty value]
  const EMPTY: [string, () => Promise<unknown>, unknown][] = [
    ['queries.getLinkedItems', () => q.getLinkedItems(), []],
    ['sync.getLastSyncedAt', () => registry.sync.getLastSyncedAt(), null],
    ['queries.getAccountRows', () => q.getAccountRows(...RANGE), []],
    ['queries.getOwnerRows', () => q.getOwnerRows(...RANGE), []],
    ['queries.getMerchantSummary', () => q.getMerchantSummary('Food', ...RANGE), []],
    ['queries.getAccountDriftData', () => q.getAccountDriftData(win, win, win, [win]), []],
    ['health.getHealthHistory', () => registry.health.getHealthHistory(), []],
    ['accounts.checkKeyHealth', () => registry.accounts.checkKeyHealth(), { ok: true }],
    // unknown transaction id: no suggestion (null, not undefined/throw)
    ['rules.suggestRuleForTransaction', () => registry.rules.suggestRuleForTransaction('nope', 'A', 'B'), null],
    ['categorize.applyCategoriesToAll', () => registry.categorize.applyCategoriesToAll(), 0],
  ];

  it.each(EMPTY)('%s resolves to the empty value and is structured-clone safe', async (_l, call, expected) => {
    const out = await call();
    expect(out).toEqual(expected);
    expect(() => structuredClone(out)).not.toThrow();
  });

  it('getFlexDriftData: every numeric field is a finite number (no NaN/undefined)', async () => {
    const out = await q.getFlexDriftData(win, win, win, [win]);
    expect(Object.keys(out).sort()).toEqual(['discretionary', 'fixed', 'flexible', 'untagged']);
    for (const [tier, slice] of Object.entries(out)) {
      for (const k of ['current', 'lastPeriodDelta', 'lastYearDelta', 'avg12mDelta', 'avg12m', 'median12m', 'medianDelta'] as const) {
        expect(Number.isFinite(slice[k]), `${tier}.${k}=${slice[k]}`).toBe(true);
      }
    }
    expect(() => structuredClone(out)).not.toThrow();
  });

  it('buildTrendViews with no categories returns only the 7 fixed views', async () => {
    const views = await registry.trends.buildTrendViews();
    expect(views.map((v) => v.label)).toEqual(['Expenses', 'Income', 'Net', 'Flexibility', 'Fixed', 'Flexible', 'Discretionary']);
    expect(() => structuredClone(views)).not.toThrow();
  });

  it('buildTrendViews appends one category view per spending category', async () => {
    await seedTx(db, { category: 'Food', amount: 5 });
    const views = await registry.trends.buildTrendViews();
    expect(views.at(-1)).toMatchObject({ mode: 'category', category: 'Food', label: 'Food' });
  });
});

describe('getLinkedItems with data', () => {
  const item = async () => (await registry.queries.getLinkedItems())[0];

  it('counts accounts as a number and reports hasCursor false without a cursor', async () => {
    await db.execute({ sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES (?,?,?,?)', args: ['item-1', 't', 'Bank', 5] });
    for (const id of ['a1', 'a2']) {
      await db.execute({ sql: "INSERT INTO accounts (id, name, type, item_id) VALUES (?, ?, 'depository', 'item-1')", args: [id, id] });
    }
    const it1 = await item();
    expect(it1).toMatchObject({ item_id: 'item-1', institution_name: 'Bank', last_synced_at: 5, account_count: 2, hasCursor: false, awaitingFirstSync: false });
    expect(typeof it1.account_count).toBe('number');
    expect(() => structuredClone(it1)).not.toThrow();
  });

  it('a stored cursor flips hasCursor', async () => {
    await db.execute({ sql: 'INSERT INTO plaid_items (item_id, access_token) VALUES (?,?)', args: ['item-1', 't'] });
    await db.execute({ sql: "INSERT INTO sync_state (account_id, cursor) VALUES ('item-1', 'c')", args: [] });
    expect((await item()).hasCursor).toBe(true);
  });

  it('a never-synced item with no accounts is awaitingFirstSync', async () => {
    await db.execute({ sql: 'INSERT INTO plaid_items (item_id, access_token) VALUES (?,?)', args: ['item-1', 't'] });
    expect(await item()).toMatchObject({ account_count: 0, last_synced_at: null, awaitingFirstSync: true });
  });
});

describe('health.getHealthHistory periods', () => {
  beforeEach(async () => {
    await db.execute("INSERT INTO accounts (id, name, type, subtype) VALUES ('chk', 'Checking', 'depository', 'checking')");
    for (const [d, b] of [['2025-01-15', 100], ['2025-02-15', 200], ['2025-03-15', 300]] as const) {
      await db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?,?,?)', args: ['chk', b, d] });
    }
  });
  const hist = registry.health.getHealthHistory;

  it("defaults to 'month' granularity, ascending, with every field present", async () => {
    const all = await hist();
    expect(all.map((p) => p.period)).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(all.map((p) => p.cash)).toEqual([100, 200, 300]);
    for (const p of all) {
      for (const k of ['period', 'asOf', 'cash', 'liquid', 'retirement', 'totalDebt', 'loanDebt', 'netWorth',
        'avgMonthlyExpenses', 'monthlyIncome', 'monthlySavings', 'basis', 'basisLabel'] as const) {
        expect(p[k], k).not.toBeUndefined();
      }
      expect(Number.isFinite(p.netWorth)).toBe(true);
    }
    expect(() => structuredClone(all)).not.toThrow();
  });

  it('periods=2 returns the LAST two, still ascending', async () => {
    expect((await hist('month', 2)).map((p) => p.period)).toEqual(['2025-02', '2025-03']);
  });

  it.each([0, -1, undefined])('periods=%s returns all rows', async (n) => {
    expect(await hist('month', n as number | undefined)).toHaveLength(3);
  });

  it('periods larger than the data returns all rows', async () => {
    expect(await hist('month', 99)).toHaveLength(3);
  });
});

describe('categorize.applyCategoriesToAll with data', () => {
  it('re-categorizes an uncategorized row via a matching rule, persisted, and returns the count', async () => {
    await db.execute({ sql: "INSERT INTO category_rules (match_type, pattern, category) VALUES ('name', 'Starbucks', 'Coffee')", args: [] });
    const hit = await seedTx(db, { name: 'Starbucks #12', category: 'Uncategorized' });
    const miss = await seedTx(db, { name: 'Unknown Vendor', category: 'Uncategorized' });
    expect(await registry.categorize.applyCategoriesToAll()).toBe(1);
    const cat = async (id: string) =>
      ((await db.execute({ sql: 'SELECT category FROM transactions WHERE id = ?', args: [id] })).rows[0] as any).category;
    expect(await cat(hit.id)).toBe('Coffee');
    expect(await cat(miss.id)).toBe('Uncategorized');
    // idempotent: nothing left to change
    expect(await registry.categorize.applyCategoriesToAll()).toBe(0);
  });
});
