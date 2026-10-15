// Real, static-import wiring for the core-backed namespaces that are safe to
// bundle into a browser build today. Mirrors gui/main/registry.ts's shape
// (same namespace names, same functions) but imports core/*.ts directly into
// this bundle instead of dispatching over Electron IPC to a Node process.
//
// This works for the namespaces below because, per web/vite.config.ts, every
// core module's `from './db.js'` (at whatever relative depth) is aliased to
// core/db.browser.ts — vassal-core's @libsql/client-wasm + OPFS
// implementation — for this build only, and each of these namespaces was
// checked (by reading their full import chains, not assumed) to be free of
// node:fs / node:path / node:crypto and of core/csv.ts, core/crypto.ts,
// core/canvas-history.ts — the modules that still assume a real filesystem:
//
//   queries      <- core/queries.ts        (db, filters, dateUtils)
//   transactions <- core/transactions.ts   (+ categorize, rename, rule-utils)
//   tags         <- core/tags.ts           (+ tag-rules -> rule-utils)
//   rules        <- core/rule-utils.ts, core/tag-rules.ts, core/rules.ts
//   health       <- core/health.ts         (+ calculator, queries)
//   trends       <- core/trends.ts         (+ queries)
//   settings     <- core/settings.ts
//   imports      <- core/imports.ts
//   profile      <- core/profile.ts
//   accounts     <- core/accounts.ts       (+ dedup for getCsvPlaidDupeCandidates)
//
// vassal-core split core/csv.ts's pure helpers (parseDate,
// parseCurrencyAmount, dedupKey, assignOrdinals) into a new zero-import
// core/csv-utils.ts and pointed core/accounts.ts and core/imports.ts at that
// instead — the node:crypto dependency (file hashing) that used to make
// core/accounts.ts's whole import chain unbundlable stayed behind in
// core/csv.ts, which accounts.ts no longer imports. Checked directly
// (`grep -n "from 'node:" core/accounts.ts core/csv-utils.ts` is empty for
// both), so accounts is wired below like every other clean namespace.
//
// NOT wired here — these are separate namespaces at the API level (no
// overlap with the clean ones above), so they're simply left out of
// `browserRegistry` and reported with a specific reason by callCore:
//
//   accounts.checkKeyHealth — separately sourced from core/key-health.ts,
//     which imports core/crypto.ts (decrypting a local API-key file). Doesn't
//     just fail to bundle — conceptually doesn't apply to the web/hosted
//     model anyway (the sync server holds the keys server-side).
//   canvas — core/canvas-history.ts reads/writes canvas-history.json via
//     node:fs directly. Needs its own browser storage story (OPFS/
//     IndexedDB or a server-hosted equivalent), which core hasn't built.
//   sync — core/sync.ts imports core/plaid.ts (operator Plaid credentials)
//     and core/crypto.ts (decrypting locally-stored access tokens). Wrong
//     architecture for web even once bundlable: a browser session should
//     sync through the sync server's Plaid proxy instead of holding Plaid access
//     tokens itself — see web/src/account-client.ts's plaidClient.
//   config.writeEnv — edits a local .env file; Electron/desktop-only.
//   files.pickCsv — native file picker dialog; Electron-only (a web CSV
//     import would need <input type="file"> + FileReader, not built yet).

export { initDb } from '../../core/db.browser.js';

import {
  getRangeSummary,
  getFlexSummary,
  getMerchantSummary,
  getUncategorizedCount,
  getDataBounds,
  getAccountRows,
  getOwnerRows,
  getFilterOptions,
  getCategoryDriftData,
  getFlexDriftData,
  getAccountDriftData,
  getSearchFilteredData,
  countSearchMatches,
  getTransactions,
  getAllCategories,
  getHiddenCategorySet,
  getNetWorthHistory,
  getAccountsWithBalances,
  getLinkedAccounts,
  getLinkedItems,
  getImportTargets,
  getAllTags,
  getTagSummary,
  getAllRules,
  getAllNameRules,
  getAllTagRules,
  getCategoryDetails,
  toggleHiddenCategory,
  getLastSyncedAt,
} from '../../core/queries.js';
import {
  setTransactionCategory,
  clearTransactionOverride,
  setTransactionDate,
  clearTransactionDate,
  setTransactionIgnored,
  setTransactionDisplayName,
  deleteTransaction,
  upsertCategoryRule,
  upsertNameRule,
  setTransactionCategoryBulk,
  clearOverridesBulk,
  setIgnoredBulk,
  addTransaction,
} from '../../core/transactions.js';
import { exportTransactionsCsv } from '../../core/export.js';
import { previewBalanceImport, commitBalanceImport } from '../../core/balance-import.js';
import {
  getTagOptions,
  getTransactionTagIds,
  getOrCreateTag,
  addTagToTransaction,
  removeTagFromTransaction,
  addTagToTransactions,
  createTag,
  renameTag,
  deleteTag,
} from '../../core/tags.js';
import { countPatternMatches } from '../../core/rule-utils.js';
import { countTagRuleMatches } from '../../core/tag-rules.js';
import {
  getUncategorizedCount as getTotalUncategorizedCount,
  deleteCategoryRule,
  deleteNameRule,
  saveCategoryRule,
  saveNameRule,
  saveTagRule,
  deleteTagRule,
  setCategoryFlexibility,
  createCategory,
  deleteCategory,
  renameCategory,
  suggestRuleForTransaction,
} from '../../core/rules.js';
import { loadHealthData, yearsToFire, coastYears, getHealthHistory } from '../../core/health.js';
import {
  getSetting,
  setSetting,
  PRETAX_MONTHLY_KEY,
  BACKUP_INCLUDE_KEY_KEY,
} from '../../core/settings.js';
import {
  buildTrendViews,
  getPeriodTotals,
  getSearchPeriodTotals,
  getSearchMatchingPeriods,
} from '../../core/trends.js';
import { getImports, getImportsOfFile, getImportImpact, deleteImport, moveImport } from '../../core/imports.js';
import { loadProfile, saveProfile, householdMembers } from '../../core/profile.js';
import {
  updateAccountTypeSubtype,
  updateAccountNickname,
  updateAccountOwner,
  updateAccountApr,
  updateAccountExcluded,
  updateAccountValue,
  createManualAccount,
  createCsvAccount,
  deleteAccount,
  importCsvTransactions,
  deleteDuplicate,
  deleteAllDuplicates,
} from '../../core/accounts.js';
import { getCsvPlaidDupeCandidates } from '../../core/dedup.js';

export const browserRegistry = {
  queries: {
    getRangeSummary,
    getFlexSummary,
    getMerchantSummary,
    getUncategorizedCount,
    getDataBounds,
    getAccountRows,
    getOwnerRows,
    getFilterOptions,
    getCategoryDriftData,
    getFlexDriftData,
    getAccountDriftData,
    getSearchFilteredData,
    countSearchMatches,
    getTransactions,
    getAllCategories,
    getHiddenCategorySet,
    getNetWorthHistory,
    getAccountsWithBalances,
    getLinkedAccounts,
    getLinkedItems,
    getImportTargets,
    getAllTags,
    getTagSummary,
  },
  transactions: {
    setTransactionCategory,
    clearTransactionOverride,
    setTransactionDate,
    clearTransactionDate,
    setTransactionIgnored,
    setTransactionDisplayName,
    deleteTransaction,
    upsertCategoryRule,
    upsertNameRule,
    setTransactionCategoryBulk,
    clearOverridesBulk,
    setIgnoredBulk,
    addTransaction,
    exportTransactionsCsv,
  },
  tags: {
    getTagOptions,
    getTransactionTagIds,
    getOrCreateTag,
    addTagToTransaction,
    removeTagFromTransaction,
    addTagToTransactions,
    createTag,
    renameTag,
    deleteTag,
  },
  rules: {
    countPatternMatches,
    countTagRuleMatches,
    getAllRules,
    getAllNameRules,
    getAllTagRules,
    getCategoryDetails,
    toggleHiddenCategory,
    getTotalUncategorizedCount,
    deleteCategoryRule,
    deleteNameRule,
    saveCategoryRule,
    saveNameRule,
    saveTagRule,
    deleteTagRule,
    setCategoryFlexibility,
    createCategory,
    deleteCategory,
    renameCategory,
    suggestRuleForTransaction,
  },
  health: {
    loadHealthData,
    yearsToFire,
    coastYears,
    getHealthHistory,
  },
  trends: {
    buildTrendViews,
    getPeriodTotals,
    getSearchPeriodTotals,
    getSearchMatchingPeriods,
  },
  imports: {
    getImports,
    getImportsOfFile,
    getImportImpact,
    deleteImport,
    moveImport,
  },
  balanceImport: {
    previewBalanceImport,
    commitBalanceImport,
  },
  profile: {
    loadProfile,
    saveProfile,
    getHouseholdMembers: async (): Promise<string[]> => householdMembers(await loadProfile()),
  },
  settings: {
    getPretaxMonthly: () => getSetting(PRETAX_MONTHLY_KEY),
    setPretaxMonthly: (v: string) => setSetting(PRETAX_MONTHLY_KEY, v),
    getBackupIncludeKey: () => getSetting(BACKUP_INCLUDE_KEY_KEY),
    setBackupIncludeKey: (v: string) => setSetting(BACKUP_INCLUDE_KEY_KEY, v),
  },
  accounts: {
    updateAccountTypeSubtype,
    updateAccountNickname,
    updateAccountOwner,
    updateAccountApr,
    updateAccountExcluded,
    updateAccountValue,
    createManualAccount,
    createCsvAccount,
    deleteAccount,
    importCsvTransactions,
    deleteDuplicate,
    deleteAllDuplicates,
    getCsvPlaidDupeCandidates,
  },
} as const;

// Sourced from core/settings.ts directly (see the module docstring above) —
// used by the `plaid` namespace in bridge.ts, which is otherwise sync-server
// backed, since this one call is a core DB read with no Plaid/crypto
// involvement.
export { getDefaultDaysRequested } from '../../core/settings.js';

// Same story, one level down: core/queries.ts's getLastSyncedAt (imported
// above alongside the other `queries` functions) is a plain DB read with no
// Plaid/crypto involvement, but at the API level gui/main/registry.ts exposes
// it as `sync.getLastSyncedAt` (see Accounts.tsx's `api.sync.getLastSyncedAt`
// call), not `queries.getLastSyncedAt` — so it can't just live in the
// `queries` block above without breaking that contract. Re-exported here for
// bridge.ts's `sync` case to pick up directly, the same way it already does
// for plaid.getDefaultDaysRequested.
export { getLastSyncedAt };

const NOT_BUNDLED_REASON: Record<string, string> = {
  'accounts.checkKeyHealth':
    'sourced from core/key-health.ts, which decrypts a local API-key file — doesn’t apply to the web/hosted model, where the sync server holds keys server-side.',
  canvas:
    'core/canvas-history.ts reads/writes canvas-history.json via node:fs directly; needs a browser storage story (OPFS/IndexedDB) core hasn’t built yet.',
  sync:
    'core/sync.ts talks to Plaid with operator credentials and locally-decrypted access tokens; on the web this should go through the sync server’s Plaid proxy instead (see web/src/account-client.ts), not through core/sync.ts at all.',
  config: 'writes a local .env file — Electron/desktop-only; the sync server holds API keys server-side on the web.',
  files: 'uses the native file picker dialog — Electron-only; a web CSV import needs <input type="file"> instead, not built yet.',
};

export const BROWSER_NAMESPACES = new Set(Object.keys(browserRegistry));

export async function callCore(ns: string, fn: string, args: unknown[]): Promise<unknown> {
  const namespace = (browserRegistry as Record<string, Record<string, unknown> | undefined>)[ns];
  const f = namespace?.[fn];
  if (typeof f === 'function') return (f as (...a: unknown[]) => unknown)(...args);

  const reason = NOT_BUNDLED_REASON[`${ns}.${fn}`] ?? NOT_BUNDLED_REASON[ns];
  throw new Error(
    reason
      ? `"${ns}.${fn}" isn't available in the web build: ${reason}`
      : `web bridge: unknown call ${ns}.${fn}`,
  );
}
