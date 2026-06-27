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
  getCsvAccounts,
  getAllTags,
  getTagSummary,
  getAllRules,
  getAllNameRules,
  getCategoryDetails,
  toggleHiddenCategory,
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
import {
  getUncategorizedCount as getTotalUncategorizedCount,
  deleteCategoryRule,
  deleteNameRule,
  saveCategoryRule,
  saveNameRule,
  setCategoryFlexibility,
  createCategory,
  deleteCategory,
  renameCategory,
} from '../../core/rules.js';
import { loadHealthData, yearsToFire, coastYears } from '../../core/health.js';
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
import { getCsvPlaidDupeCandidates } from '../../core/dedup.js';
import { applyCategoriesToAll } from '../../core/categorize.js';
import { loadProfile, saveProfile, householdMembers } from '../../core/profile.js';
import { syncAll } from '../../core/sync.js';
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
    getCsvAccounts,
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
    getAllRules,
    getAllNameRules,
    getCategoryDetails,
    toggleHiddenCategory,
    getTotalUncategorizedCount,
    deleteCategoryRule,
    deleteNameRule,
    saveCategoryRule,
    saveNameRule,
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
    syncAll,
  },
  config: {
    writeEnv: async (updates: EnvUpdates): Promise<{ written: string[] }> => {
      const { written } = writeEnvFile(updates);
      return { written };
    },
  },
} as const;
