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
  setTransactionIgnored,
  setTransactionDisplayName,
  deleteTransaction,
  upsertCategoryRule,
  upsertNameRule,
  setTransactionCategoryBulk,
  clearOverridesBulk,
  setIgnoredBulk,
} from '../../core/transactions.js';
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
} from '../../core/rules.js';
import { loadHealthData, yearsToFire, coastYears } from '../../core/health.js';
import { getSetting, setSetting, PRETAX_MONTHLY_KEY } from '../../core/settings.js';
import {
  buildTrendViews,
  getPeriodTotals,
  getSearchPeriodTotals,
  getSearchMatchingPeriods,
} from '../../core/trends.js';
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
import {
  getImports, getImportsOfFile, getImportImpact, deleteImport, moveImport,
} from '../../core/imports.js';
import { getCsvPlaidDupeCandidates } from '../../core/dedup.js';
import { applyCategoriesToAll } from '../../core/categorize.js';
import { loadProfile, saveProfile, householdMembers } from '../../core/profile.js';
import { syncAll, deleteSyncCursor } from '../../core/sync.js';
import { setSyncResult, mergeSyncResult, getSyncFailures } from '../../core/sync-status.js';
import { loadHistory, deleteHistoryEntry, CANVAS_SPEC_PATH } from '../../core/canvas-history.js';
import type { CanvasSpec } from '../../core/canvas-spec.js';
import { writeEnvFile, type EnvUpdates } from '../../core/env-file.js';
import { readFileSync } from 'node:fs';

// Explicit picks (no module spreads): keeps the IPC surface intentional and
// excludes non-structured-cloneable exports like buildSearchRe.
// Electron-free on purpose — tests import this without an electron runtime.
export const registry = {
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
    setTransactionIgnored,
    setTransactionDisplayName,
    deleteTransaction,
    upsertCategoryRule,
    upsertNameRule,
    setTransactionCategoryBulk,
    clearOverridesBulk,
    setIgnoredBulk,
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
  },
  health: {
    loadHealthData,
    yearsToFire,
    coastYears,
  },
  trends: {
    buildTrendViews,
    getPeriodTotals,
    getSearchPeriodTotals,
    getSearchMatchingPeriods,
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
  imports: {
    getImports,
    getImportsOfFile,
    getImportImpact,
    deleteImport,
    moveImport,
  },
  categorize: {
    applyCategoriesToAll,
  },
  profile: {
    loadProfile,
    saveProfile,
    getHouseholdMembers: async (): Promise<string[]> => householdMembers(await loadProfile()),
  },
  canvas: {
    loadHistory,
    deleteHistoryEntry,
    loadCurrentSpec: async (): Promise<(CanvasSpec & { _writtenAt?: number }) | null> => {
      try {
        return JSON.parse(readFileSync(CANVAS_SPEC_PATH, 'utf-8'));
      } catch {
        return null;
      }
    },
  },
  sync: {
    // Wrap so every user-triggered sync records its outcome in the shared store,
    // which drives the renderer banner + row badges via the sync-status push.
    syncAll: async (force?: boolean) => {
      const results = await syncAll(force);
      setSyncResult(results);
      return results;
    },
    // Delete one item's cursor and resync it, so Plaid resends its full history.
    // Composed here rather than in the renderer so the two steps can't be
    // interleaved with another sync, and merged rather than set so the other
    // institutions keep their failure badges.
    deleteCursorAndResync: async (itemId: string) => {
      await deleteSyncCursor(itemId);
      const results = await syncAll(true, [itemId]);
      mergeSyncResult(results, [itemId]);
      return results[0];
    },
    // Initial hydration for a renderer that mounts after a background sync failed.
    getStatus: async () => getSyncFailures(),
    getLastSyncedAt,
  },
  config: {
    writeEnv: async (updates: EnvUpdates): Promise<{ written: string[] }> => {
      const { written } = writeEnvFile(updates);
      return { written };
    },
  },
  settings: {
    getPretaxMonthly: () => getSetting(PRETAX_MONTHLY_KEY),
    setPretaxMonthly: (v: string) => setSetting(PRETAX_MONTHLY_KEY, v),
  },
} as const;
