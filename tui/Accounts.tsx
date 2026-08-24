import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { useSetTyping } from './TypingContext.js';
import { useRefreshKey } from './RefreshContext.js';
import { spawn } from 'node:child_process';
import { syncAll, deleteSyncCursor, describeSyncProgress, type SyncItemResult, type SyncProgress } from '../core/sync.js';
import { setSyncResult, mergeSyncResult } from '../core/sync-status.js';
import {
  refreshTransactions, describeRefreshProgress, describeRefreshResult,
  POLL_DELAYS_MS, type RefreshProgress,
} from '../core/transactions-refresh.js';
import { plaidErrorMessage } from '../core/plaid.js';
import { useSyncStatus } from './SyncStatusContext.js';
import { getCsvPlaidDupeCandidates, type DupePair } from '../core/dedup.js';
import { parseCSV, parseDate } from '../core/csv.js';
import { getLinkedAccounts, getCsvAccounts, getLinkedItems, type LinkedAccount, type CsvAccount, type LinkedItem } from '../core/queries.js';
import { loadProfile, householdMembers } from '../core/profile.js';
import { getDefaultDaysRequested, MIN_DAYS_REQUESTED, MAX_DAYS_REQUESTED } from '../core/settings.js';
import {
  updateAccountTypeSubtype, updateAccountNickname, updateAccountOwner, updateAccountApr, updateAccountExcluded, updateAccountValue,
  createManualAccount, createCsvAccount, deleteAccount, importCsvTransactions, deleteDuplicate, deleteAllDuplicates,
} from '../core/accounts.js';
import type { Screen, TxFilter } from './App.js';
import { truncate, Divider } from './fmt.js';
import { fmtSyncedAt } from '../core/fmt.js';
import { handleNavKey } from './nav.js';
import { useLoadGuard } from './useLoadGuard.js';
import { useTerminalWidth, MONTHS, SUBTYPE_DISPLAY, C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_ACCENT, C_MANUAL, C_DIM } from './ui.js';
import { ModalPanel, TextInput, SelectableRow, useStatusMessage, PageHeader, EditTextField, EditToggleField } from './components/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type MainView = 'accounts' | 'links' | 'add-data' | 'dupes';
type AcctMode = 'list' | 'edit' | 'update-value' | 'confirm-delete';
type EditField = 'nickname' | 'owner' | 'type' | 'subtype' | 'apr' | 'excluded';

type AddStep =
  | 'landing'
  | 'link-days'
  | 'link-plaid'
  | 'file'
  | 'map-date'
  | 'map-name'
  | 'map-amount-mode'
  | 'map-amount'
  | 'map-debit'
  | 'map-credit'
  | 'direction'
  | 'account'
  | 'confirm'
  | 'done'
  | 'manual-name'
  | 'manual-value'
  | 'manual-confirm'
  | 'manual-done'
  | 'new-acct-name'
  | 'new-acct-type';

const ACCOUNT_TYPES = ['depository', 'investment', 'credit', 'loan', 'other'] as const;

const SUBTYPES: Record<string, string[]> = {
  depository:  ['checking', 'savings', 'money market', 'cd', 'hsa', 'prepaid', 'cash management', 'ebt', 'paypal'],
  investment:  ['brokerage', '401k', 'ira', 'roth', 'roth 401k', '403b', '457b', '529', 'hsa', 'pension', 'mutual fund', 'stock plan', 'sep ira', 'simple ira', 'thrift savings plan', 'ugma', 'utma'],
  credit:      ['credit card', 'paypal'],
  loan:        ['mortgage', 'student', 'auto', 'home equity', 'personal', 'line of credit', 'business', 'other'],
  other:       [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pulls the local link server's URL out of a stdout chunk from scripts/link.ts.
 *  It's printed once, early, and later status lines would otherwise scroll it
 *  away — so we capture it and pin it for the life of the link. */
export function extractLinkUrl(chunk: string): string | null {
  return chunk.match(/https?:\/\/localhost:\d+/)?.[0] ?? null;
}

function fmtDate(d: string | null): string {
  if (!d) return 'never';
  const dt = new Date(d + 'T12:00:00');
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Accounts({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  // Main view toggle
  const [mainView, setMainView] = useState<MainView>('accounts');

  // Accounts view state
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [acctCursor, setAcctCursor] = useState(0);
  const [acctMode, setAcctMode] = useState<AcctMode>('list');
  const [editField, setEditField] = useState<EditField>('type');
  const [editType, setEditType] = useState('');
  const [editSubtype, setEditSubtype] = useState('');
  const { statusMsg: acctMsg, showStatus: showAcctMsg } = useStatusMessage(2500);
  const { statusMsg: acctErr, showStatus: showAcctErr } = useStatusMessage(3000);

  // Sync state (shared)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');
  // Mirrors syncStatus for readers that outlive the render they were created in
  // — the Plaid link's close handler fires long after startPlaidLink captured
  // its scope, so reading the state variable there would see a stale value.
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;
  const [syncMsg, setSyncMsg] = useState('');
  // Item ids that failed the most recent sync (from either the startup or the
  // user-triggered path), so their account rows can be badged. Session-only.
  const { failingItems } = useSyncStatus();

  // Add-data / link state
  const [addStep, setAddStep] = useState<AddStep>('landing');
  const [linkStatus, setLinkStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [linkMsg, setLinkMsg] = useState('');
  // Held separately from linkMsg, which every new status line overwrites. On
  // Linux there is no `open`/`xdg-open`, so the browser never launches itself
  // and this URL is the user's only way into the Plaid flow.
  const [linkUrl, setLinkUrl] = useState('');
  // Last stderr text from the link subprocess. Read from the long-lived close
  // handler, so it's a ref rather than state.
  const linkErrRef = useRef('');
  // Whether the Plaid panel is adding a connection or updating an existing
  // one's credentials — the two flows share the panel but not the wording.
  const [linkMode, setLinkMode] = useState<'add' | 'update'>('add');
  const [daysInput, setDaysInput] = useState(String(MAX_DAYS_REQUESTED));
  const [daysError, setDaysError] = useState('');
  // Default history window derived from the start date set during setup.
  const [defaultDays, setDefaultDays] = useState(MAX_DAYS_REQUESTED);
  useEffect(() => {
    void getDefaultDaysRequested().then(setDefaultDays);
  }, []);

  // CSV import state
  const [filePath, setFilePath] = useState('');
  const [fileError, setFileError] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvFile, setCsvFile] = useState<{ name: string; hash: string }>({ name: '', hash: '' });
  const [colCursor, setColCursor] = useState(0);
  const [dateCol, setDateCol] = useState<number | null>(null);
  const [nameCol, setNameCol] = useState<number | null>(null);
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [amountCol, setAmountCol] = useState<number | null>(null);
  const [debitCol, setDebitCol] = useState<number | null>(null);
  const [creditCol, setCreditCol] = useState<number | null>(null);
  const [positiveIsInflow, setPositiveIsInflow] = useState(false);
  const [csvAccountCursor, setCsvAccountCursor] = useState(0);
  const [csvAccounts, setCsvAccounts] = useState<CsvAccount[]>([]);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  // Manual asset state
  const [manualName, setManualName] = useState('');
  const [manualValue, setManualValue] = useState('');
  const [manualValueError, setManualValueError] = useState('');

  // New CSV account state (inline creation during CSV import)
  const [newAcctName, setNewAcctName] = useState('');
  const [newAcctType, setNewAcctType] = useState('credit');
  const [newAcctSubtype, setNewAcctSubtype] = useState('credit card');
  const [newAcctField, setNewAcctField] = useState<'type' | 'subtype'>('type');

  // Update-value mode state
  const [updateValueInput, setUpdateValueInput] = useState('');
  const [updateValueError, setUpdateValueError] = useState('');

  // Unified edit panel state
  const [editNickname, setEditNickname] = useState('');
  // Owner holds the selected household-member name ('' = Unassigned); the editor
  // cycles over the names defined in Settings rather than accepting free text.
  const [editOwner, setEditOwner] = useState('');
  const [ownerMembers, setOwnerMembers] = useState<string[]>([]);
  const [editApr, setEditApr] = useState('');
  const [editExcluded, setEditExcluded] = useState(false);

  // Links view state — one row per Plaid connection, not per account.
  const [linkedItems, setLinkedItems] = useState<LinkedItem[]>([]);
  const [itemCursor, setItemCursor] = useState(0);
  // Refresh mode gates the billed Plaid call behind a confirmation; the poll
  // that follows reports through syncStatus, so it shares the status line and
  // blocks [s] the way a sync does. Progress is held as a step rather than a
  // string: the waiting step carries a deadline, so re-rendering it on a timer
  // turns it into a live countdown.
  const [linksMode, setLinksMode] = useState<'list' | 'confirm-refresh' | 'confirm-delete-cursor'>('list');
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const [, setRefreshTick] = useState(0);
  useEffect(() => {
    if (refreshProgress?.phase !== 'waiting') return;
    const t = setInterval(() => setRefreshTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [refreshProgress]);
  // Abort an in-flight poll if the screen goes away mid-refresh, so its timer
  // and its sync don't outlive the component.
  useEffect(() => () => refreshAbortRef.current?.abort(), []);

  // Dupes view state
  const [dupes, setDupes] = useState<DupePair[]>([]);
  const [dupeCursor, setDupeCursor] = useState(0);
  // The dupe scan runs detached from loadAccounts, so the view can be opened
  // while it is still running. Without this an in-flight scan renders as
  // "No duplicate candidates found." — a false all-clear, and most likely
  // right after a CSV import, which is when duplicates are most expected.
  const [dupesLoading, setDupesLoading] = useState(false);
  // Reloads can overlap (a mutation refresh landing during a slow scan), so an
  // earlier scan must not overwrite a later one's result.
  const dupesGuard = useLoadGuard();

  // Elapsed-seconds ticker for the two phases that block on the network (the
  // Plaid link subprocess, then the sync). A static label can't distinguish
  // "still working" from "hung", which is what makes people kill the terminal
  // mid-link. Keyed on the phase so the count restarts when link hands off to
  // sync rather than running straight through both.
  const busyPhase = linkStatus === 'running' ? 'link' : syncStatus === 'syncing' ? 'sync' : null;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!busyPhase) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busyPhase]);
  // Only shown once it's long enough to be worth reassuring about, and pinned to
  // the line for the phase it's actually timing — otherwise the sync's counter
  // renders next to the finished link message and reads as a stalled link.
  const elapsedSuffix = busyPhase && elapsed >= 2 ? `  ${elapsed}s` : '';
  const linkElapsed = busyPhase === 'link' ? elapsedSuffix : '';
  const syncElapsed = busyPhase === 'sync' ? elapsedSuffix : '';

  const setTyping = useSetTyping();
  const TEXT_INPUT_STEPS = new Set<AddStep>(['link-days', 'file', 'manual-name', 'manual-value', 'new-acct-name']);
  const TEXT_INPUT_MODES = new Set<AcctMode>(['edit', 'update-value']);
  useEffect(() => {
    setTyping(TEXT_INPUT_STEPS.has(addStep) || TEXT_INPUT_MODES.has(acctMode));
  }, [addStep, acctMode]);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // [sel=2] gap [name] gap [✎=1] gap [mask=7] gap [type=14] gap [inst] gap [synced~21]
  // 6 gaps of 2 = 12; fixed: 2+1+7+14+21+12 = 57
  // 21 is '◷ awaiting first sync', the widest synced cell; the relative strings
  // ('synced 20 hr ago') top out around 16.
  const acctFlex = Math.max(20, inner - 57);
  const acctNameW = Math.max(14, Math.floor(acctFlex * 0.6));
  const acctInstW = Math.max(8,  acctFlex - acctNameW);

  // Resolves to the loaded list so callers can act on it — the post-link handler
  // reads the placeholder rows to learn which items need a first sync.
  async function loadAccounts(): Promise<LinkedAccount[]> {
    const accts = await getLinkedAccounts();
    setLinkedAccounts(accts);
    // Cheap item-level query; kept in step with the account list so a sync or a
    // link updates both views at once.
    void getLinkedItems().then((items) => {
      setLinkedItems(items);
      setItemCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
    });
    // Deliberately not awaited. The dupe scan is an unindexed self-join over the
    // whole transactions table — measured at 5s for 20k rows and 49s for 40k
    // once CSV imports are present. Nothing here needs it, and awaiting it after
    // a link delayed the sync itself by that much, which read as a hang. The
    // Dupes view reports it as still running instead of claiming a clean result.
    const token = dupesGuard.begin();
    setDupesLoading(true);
    void getCsvPlaidDupeCandidates()
      .then((rows) => { if (dupesGuard.isLatest(token)) setDupes(rows); })
      .finally(() => { if (dupesGuard.isLatest(token)) setDupesLoading(false); });
    return accts;
  }
  useEffect(() => { void loadAccounts(); }, [refreshKey]);
  useEffect(() => {
    void loadProfile().then((p) => setOwnerMembers(householdMembers(p)));
  }, [isActive]);

  function openEdit(acct: LinkedAccount) {
    const type = acct.type;
    const subtypes = SUBTYPES[type] ?? [];
    const currentSub = acct.subtype ?? '';
    const snapped = subtypes.includes(currentSub) ? currentSub : (subtypes[0] ?? '');
    setEditType(type);
    setEditSubtype(snapped);
    setEditNickname(acct.nickname ?? '');
    setEditOwner(acct.owner ?? '');
    setEditApr(acct.apr !== null && acct.apr !== undefined ? String(acct.apr) : '');
    setEditExcluded(acct.excluded);
    setEditField('nickname');
    setAcctMode('edit');
  }

  async function saveEdit() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    const isDebt = editType === 'credit' || editType === 'loan';
    const aprVal = editApr.trim() ? parseFloat(editApr) : null;
    try {
      await updateAccountTypeSubtype(acct.id, editType, editSubtype.trim() || null);
      await updateAccountNickname(acct.id, editNickname.trim() || null);
      await updateAccountOwner(acct.id, editOwner.trim() || null);
      await updateAccountExcluded(acct.id, editExcluded);
      if (isDebt) await updateAccountApr(acct.id, aprVal !== null && !isNaN(aprVal) ? aprVal : null);
      setAcctMode('list');
      showAcctMsg(`Updated ${editNickname.trim() || acct.name}`);
      void loadAccounts();
    } catch {
      showAcctErr(`Failed to update ${acct.name}`);
    }
  }

  // Name the accounts behind a failed item so the status line points at the row,
  // not an opaque item id. Falls back to the item id if accounts aren't loaded yet.
  function describeSyncFailures(failed: SyncItemResult[]): string {
    return failed.map((r) => {
      const names = linkedAccounts.filter((a) => a.item_id === r.itemId).map((a) => a.nickname ?? a.name);
      const who = names.length > 0 ? names.join(', ') : r.itemId;
      return `${who} — ${r.error}`;
    }).join('  ·  ');
  }

  // Names the step the sync is currently on. Without this the label sits on
  // "Syncing…" for the whole run, which on a large backfill is minutes of the
  // UI looking identical to a hang.
  function reportProgress(_itemId: string, p: SyncProgress) {
    setSyncMsg(describeSyncProgress(p));
  }

  /** A sync parked because one was already in flight when a link finished.
   *  Without this the new institution's first sync was dropped silently and its
   *  row sat at "awaiting first sync" until the next launch. */
  const pendingSyncRef = useRef<{ itemIds: string[]; startMsg?: string } | null>(null);

  /** Run a parked sync, if any. Reports whether it started one, so the caller
   *  can skip idling out a status line the queued run has just taken over.
   *  Clears the ref first, so a queued run draining into itself can't loop. */
  function drainPendingSync(): boolean {
    const pending = pendingSyncRef.current;
    pendingSyncRef.current = null;
    if (!pending || pending.itemIds.length === 0) return false;
    syncItems(pending.itemIds, pending.startMsg);
    return true;
  }

  /** Sync `itemIds` now, or park them if a sync is already running. */
  function syncItemsWhenFree(itemIds: string[], startMsg?: string) {
    if (itemIds.length === 0) return;
    if (syncStatusRef.current === 'syncing') pendingSyncRef.current = { itemIds, startMsg };
    else syncItems(itemIds, startMsg);
  }

  function forceSync() {
    syncStatusRef.current = 'syncing';   // visible before the re-render lands
    setSyncStatus('syncing');
    setSyncMsg('Syncing…');
    syncAll(true, undefined, reportProgress).then((results) => {
      const failed = results.filter((r) => r.error);
      // Feed the shared store: updates the row badges here and the global banner.
      // A clean run stores an empty set, clearing both.
      setSyncResult(results);
      void loadAccounts();
      if (failed.length > 0) {
        // Errors stay put until the user presses a key (see useInput) — long
        // enough to read, and there's a real problem to act on.
        setSyncStatus('error');
        setSyncMsg(`Sync failed: ${describeSyncFailures(failed)}`);
        // A queued run replaces this line, but the failure itself survives in
        // the shared store as the row badge and the global banner.
        drainPendingSync();
      } else {
        const added = results.reduce((s, r) => s + r.added, 0);
        setSyncMsg(`Done — ${added} new transaction${added !== 1 ? 's' : ''}`);
        setSyncStatus('done');
        if (!drainPendingSync()) setTimeout(() => { setSyncStatus('idle'); setSyncMsg(''); }, 4000);
      }
    }).catch((err) => {
      // syncAll no longer throws on per-item failure, so this is a broader fault
      // (e.g. Plaid not configured, DB error). Surface its real message.
      setSyncMsg(`Sync failed — ${plaidErrorMessage(err)}`);
      setSyncStatus('error');
    });
  }

  /** Sync just the given items — used right after a link so the new institution
   *  syncs immediately. Mirrors forceSync but merges its outcome so another
   *  institution's failure badge survives a scoped run. */
  function syncItems(
    itemIds: string[],
    startMsg = 'Syncing new institution…',
    // A cursor-zero resync reports every transaction Plaid holds as `added`, so
    // the default "N new transactions" would badly overstate it — the caller
    // that knows better supplies its own wording.
    doneMsg: (added: number) => string = (added) => `Done — ${added} new transaction${added !== 1 ? 's' : ''}`,
  ) {
    syncStatusRef.current = 'syncing';   // visible before the re-render lands
    setSyncStatus('syncing');
    setSyncMsg(startMsg);
    syncAll(true, itemIds, reportProgress).then((results) => {
      const failed = results.filter((r) => r.error);
      mergeSyncResult(results, itemIds);
      void loadAccounts();
      if (failed.length > 0) {
        setSyncStatus('error');
        setSyncMsg(`Sync failed: ${describeSyncFailures(failed)}`);
        drainPendingSync();
      } else {
        const added = results.reduce((s, r) => s + r.added, 0);
        setSyncMsg(doneMsg(added));
        setSyncStatus('done');
        if (!drainPendingSync()) setTimeout(() => { setSyncStatus('idle'); setSyncMsg(''); }, 4000);
      }
    }).catch((err) => {
      setSyncMsg(`Sync failed — ${plaidErrorMessage(err)}`);
      setSyncStatus('error');
    });
  }

  /** Ask this connection's bank to go look for new transactions now, then watch
   *  for what turns up. Item-scoped, like every other action on this tab. */
  function startRefresh(item: LinkedItem) {
    setLinksMode('list');
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setSyncStatus('syncing');
    setSyncMsg('');
    setRefreshProgress({ phase: 'requesting' });

    refreshTransactions(item.item_id, { signal: controller.signal, onProgress: setRefreshProgress })
      .then((result) => {
        refreshAbortRef.current = null;
        setRefreshProgress(null);
        // A check that ran is a real sync outcome: it raises this item's ⚠ badge
        // when it failed and clears a stale one when it didn't. Scoped to this
        // item, so another connection's failure survives.
        if (result.syncResults.length > 0) mergeSyncResult(result.syncResults, [item.item_id]);
        loadAccounts();
        if (result.error) {
          setSyncStatus('error');
          setSyncMsg(`Refresh failed — ${result.error}`);
          return;
        }
        setSyncMsg(describeRefreshResult(result));
        setSyncStatus('done');
        // Longer than a sync's 4s: this message is the whole answer to a
        // four-minute wait, and the no-luck case tells the user what to do next.
        setTimeout(() => { setSyncStatus('idle'); setSyncMsg(''); }, 10000);
      })
      .catch((err) => {
        refreshAbortRef.current = null;
        setRefreshProgress(null);
        setSyncMsg(`Refresh failed — ${plaidErrorMessage(err)}`);
        setSyncStatus('error');
      });
  }

  /** Forget where this connection's change feed left off, then resync it so Plaid
   *  resends everything it holds. Free, unlike [r] refresh — the cost is the time
   *  the resync takes. */
  function startDeleteCursor(item: LinkedItem) {
    setLinksMode('list');
    const label = item.institution_name ?? 'this connection';
    void deleteSyncCursor(item.item_id)
      .then(() => {
        syncItems(
          [item.item_id],
          `Sync cursor deleted — re-downloading ${label}…`,
          // Everything Plaid holds arrives as `added` here, existing rows
          // included, so this counts what was re-downloaded, not what is new.
          (added) => `Done — re-downloaded ${added.toLocaleString()} transaction${added !== 1 ? 's' : ''}`,
        );
      })
      .catch((err) => {
        setSyncMsg(`Could not delete sync cursor — ${plaidErrorMessage(err)}`);
        setSyncStatus('error');
      });
  }

  function saveNewAcct() {
    void createCsvAccount(newAcctName, newAcctType, newAcctSubtype.trim() || null).then(() => {
      void getCsvAccounts().then((accts) => {
        setCsvAccounts(accts);
        setCsvAccountCursor(accts.length - 1);
        setAddStep('account');
      });
    });
  }

  async function saveManualAsset() {
    const value = parseFloat(manualValue.replace(/[$,]/g, ''));
    if (isNaN(value) || value < 0) { setManualValueError('Enter a valid positive number'); return; }
    try {
      await createManualAccount(manualName, value);
      setAddStep('manual-done');
      void loadAccounts();
    } catch {
      setManualValueError('Failed to save asset — please try again');
    }
  }

  async function handleDeleteAccount() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    try {
      await deleteAccount(acct.id);
      setAcctMode('list');
      setAcctCursor((c) => Math.max(0, c - 1));
      showAcctMsg(`Deleted ${acct.nickname ?? acct.name}`);
      void loadAccounts();
    } catch {
      setAcctMode('list');
      showAcctErr(`Failed to delete ${acct.nickname ?? acct.name}`);
    }
  }

  async function saveUpdatedValue() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    const value = parseFloat(updateValueInput.replace(/[$,]/g, ''));
    if (isNaN(value) || value < 0) { setUpdateValueError('Enter a valid positive number'); return; }
    try {
      await updateAccountValue(acct.id, value);
      setAcctMode('list');
      showAcctMsg(`Updated value for ${acct.name}`);
      void loadAccounts();
    } catch {
      setUpdateValueError('Failed to update value — please try again');
    }
  }

  // `updateItemId` re-authorizes that Item in place (Plaid update mode) instead
  // of linking a new one, which is what keeps its accounts and transactions
  // intact. The history window can't be changed on an update, so `days` is only
  // meaningful when adding.
  function startPlaidLink(days = 730, updateItemId?: string) {
    setLinkMode(updateItemId ? 'update' : 'add');
    setLinkStatus('running');
    setLinkMsg('Opening browser…');
    setLinkUrl('');
    linkErrRef.current = '';
    const node = process.execPath;
    const script = new URL('../scripts/link.ts', import.meta.url).pathname;
    const child = spawn(node, [
      '--no-warnings',
      '--import', 'tsx/esm',
      script,
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PLAID_DAYS_REQUESTED: String(days),
        ...(updateItemId ? { PLAID_UPDATE_ITEM_ID: updateItemId } : {}),
      },
    });
    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const url = extractLinkUrl(chunk);
      if (url) setLinkUrl(url);
      // Only the last line of the chunk becomes the status; the URL above is
      // captured from the whole chunk so it survives being scrolled past.
      const line = chunk.trim().split('\n').pop() ?? '';
      if (line) setLinkMsg(line);
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      linkErrRef.current = text;
      setLinkStatus('error');
      setLinkMsg(text);
    });
    child.on('close', (code: number) => {
      if (code === 0) {
        setLinkStatus('done');
        if (updateItemId) {
          // The item almost certainly got here by failing to sync, so its badge
          // and the global banner still show state from before the update.
          // Syncing just this item clears them and picks up whatever was missed
          // while the credentials were stale — mergeSyncResult scopes the clear
          // to the attempted item, leaving other items' failures alone.
          setLinkMsg('Link updated! Press Enter to continue.');
          void loadAccounts();
          syncItemsWhenFree([updateItemId], 'Syncing updated link…');
        } else {
          setLinkMsg('Bank connected! Press Enter to continue.');
          // The reload surfaces the institution's placeholder row immediately —
          // that alone answers "did it work?" even if the sync is slow. The
          // placeholders *are* the items needing a first sync, so the ids come
          // from the loaded list rather than out of the link subprocess's stdout.
          void loadAccounts().then((accts) => {
            const itemIds = [...new Set(accts.filter((a) => a.awaitingFirstSync).map((a) => a.item_id!))];
            syncItemsWhenFree(itemIds);
          });
        }
      } else if (code !== null) {
        setLinkStatus('error');
        // Keep the stderr reason if we captured one — it says *why* the link
        // failed, where a bare exit code says only that it did. The panel
        // already offers "Press Enter to return" for the error state.
        if (!linkErrRef.current) setLinkMsg(`Process exited with code ${code}. Press Enter to continue.`);
      }
    });
  }

  function tryLoadFile(path: string) {
    try {
      const parsed = parseCSV(path.trim());
      if (!parsed.headers.length) { setFileError('No columns found'); return; }
      setHeaders(parsed.headers);
      setCsvRows(parsed.rows);
      setCsvFile({ name: parsed.fileName, hash: parsed.fileHash });
      setFileError('');
      const h = parsed.headers.map((x) => x.toLowerCase());
      const dateGuess = h.findIndex((x) => x.includes('date') || x.includes('posted'));
      const nameGuess = h.findIndex((x) => x.includes('desc') || x.includes('name') || x.includes('merchant'));
      if (dateGuess >= 0) setDateCol(dateGuess);
      if (nameGuess >= 0) setNameCol(nameGuess);
      setColCursor(0);
      setAddStep('map-date');
    } catch (e: any) {
      setFileError(e.message);
    }
  }

  function doImport() {
    const acct = csvAccounts[csvAccountCursor];
    void importCsvTransactions(csvRows, acct, {
      amountMode, dateCol: dateCol!, nameCol: nameCol!,
      amountCol, debitCol, creditCol, positiveIsInflow,
    }, csvFile).then((result) => {
      setImportResult(result);
      setAddStep('done');
    });
  }

  function previewRow(row: string[]) {
    const date = dateCol !== null ? parseDate(row[dateCol] ?? '') : '—';
    const name = nameCol !== null ? truncate(row[nameCol] ?? '', 28) : '—';
    let amount = '—';
    if (amountMode === 'single' && amountCol !== null) {
      const raw = parseFloat(row[amountCol] || '0') || 0;
      const v = positiveIsInflow ? -raw : raw;
      amount = `$${Math.abs(v).toFixed(2)}`;
    } else if (amountMode === 'split' && debitCol !== null && creditCol !== null) {
      const d = parseFloat(row[debitCol] || '0') || 0;
      const c = parseFloat(row[creditCol] || '0') || 0;
      amount = `$${Math.abs(d > 0 ? d : c).toFixed(2)}`;
    }
    return { date, name, amount };
  }

  // ─── Input handling ──────────────────────────────────────────────────────────

  useInput((input, key) => {
    // A lingering sync error clears on the next keypress. The key still performs
    // its normal action (dismiss + act), so pressing [s] here retries the sync.
    if (syncStatus === 'error') { setSyncStatus('idle'); setSyncMsg(''); }

    // Global nav (only when not deep in a multi-step flow)
    const atTop = (mainView === 'accounts' && acctMode === 'list')
      || mainView === 'links'
      || (mainView === 'add-data' && addStep === 'landing');

    if (atTop) {
      if (handleNavKey(input, 'accounts', onNavigate)) return;
    }

    // ── Accounts view ──────────────────────────────────────────────────────────
    if (mainView === 'accounts') {
      if (acctMode === 'edit') {
        if (key.escape) { setAcctMode('list'); return; }
        if (key.return) { void saveEdit(); return; }
        const isDebt = editType === 'credit' || editType === 'loan';
        // Owner is only focusable once household members exist to cycle through.
        const editFields: EditField[] = [
          'nickname',
          ...(ownerMembers.length > 0 ? ['owner'] as const : []),
          'type', 'subtype',
          ...(isDebt ? ['apr'] as const : []),
          'excluded',
        ];
        if (key.upArrow) {
          setEditField((f) => { const i = editFields.indexOf(f); return editFields[Math.max(0, i - 1)]; });
          return;
        }
        if (key.downArrow) {
          setEditField((f) => { const i = editFields.indexOf(f); return editFields[Math.min(editFields.length - 1, i + 1)]; });
          return;
        }
        if (editField === 'type' && (key.leftArrow || key.rightArrow)) {
          const idx = ACCOUNT_TYPES.indexOf(editType as typeof ACCOUNT_TYPES[number]);
          const dir = key.leftArrow ? -1 : 1;
          const nextType = ACCOUNT_TYPES[(idx + dir + ACCOUNT_TYPES.length) % ACCOUNT_TYPES.length];
          setEditType(nextType);
          setEditSubtype(SUBTYPES[nextType]?.[0] ?? '');
          return;
        }
        if (editField === 'subtype') {
          const subtypes = SUBTYPES[editType] ?? [];
          if (subtypes.length > 0 && (key.leftArrow || key.rightArrow)) {
            const idx = subtypes.indexOf(editSubtype);
            const dir = key.leftArrow ? -1 : 1;
            setEditSubtype(subtypes[(idx + dir + subtypes.length) % subtypes.length]);
          }
          return;
        }
        if (editField === 'nickname') {
          if (key.backspace || key.delete) { setEditNickname((v) => v.slice(0, -1)); return; }
          if (input && !key.ctrl && !key.meta) { setEditNickname((v) => v + input); return; }
          return;
        }
        if (editField === 'owner') {
          if (key.leftArrow || key.rightArrow) {
            const opts = ['', ...ownerMembers]; // '' = Unassigned
            const idx = Math.max(0, opts.indexOf(editOwner));
            const dir = key.leftArrow ? -1 : 1;
            setEditOwner(opts[(idx + dir + opts.length) % opts.length]);
          }
          return;
        }
        if (editField === 'apr') {
          if (key.backspace || key.delete) { setEditApr((v) => v.slice(0, -1)); return; }
          if (input && /^[\d.]$/.test(input) && !key.ctrl && !key.meta) { setEditApr((v) => v + input); return; }
          return;
        }
        if (editField === 'excluded') {
          if (key.leftArrow || key.rightArrow || input === ' ') { setEditExcluded((v) => !v); return; }
          return;
        }
        return;
      }

      if (acctMode === 'update-value') {
        if (key.escape) { setAcctMode('list'); setUpdateValueInput(''); setUpdateValueError(''); return; }
        if (key.return) { void saveUpdatedValue(); return; }
        if (key.backspace || key.delete) { setUpdateValueInput((v) => v.slice(0, -1)); setUpdateValueError(''); return; }
        if (input && !key.ctrl && !key.meta) { setUpdateValueInput((v) => v + input); setUpdateValueError(''); return; }
        return;
      }

      if (acctMode === 'confirm-delete') {
        if (key.escape || input === 'n') { setAcctMode('list'); return; }
        if (input === 'y') { void handleDeleteAccount(); return; }
        return;
      }

      // list mode
      if (key.escape) { onNavigate('dashboard'); return; }
      if (key.tab) { setMainView('links'); return; }
      if (key.upArrow)   { setAcctCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setAcctCursor((c) => Math.min(linkedAccounts.length - 1, c + 1)); return; }
      // A placeholder row has no accounts row behind it, so edit and delete
      // would silently write zero rows. Refuse them and say why.
      if (key.return && linkedAccounts[acctCursor]) {
        if (linkedAccounts[acctCursor].awaitingFirstSync) {
          showAcctErr('Not synced yet — press [s] to sync this institution first.');
          return;
        }
        openEdit(linkedAccounts[acctCursor]);
        return;
      }
      if (input === 'v' && linkedAccounts[acctCursor]?.id.startsWith('manual-')) {
        setUpdateValueInput('');
        setUpdateValueError('');
        setAcctMode('update-value');
        return;
      }
      // Removing a mis-linked institution means deleting a plaid_items row,
      // which nothing in the codebase does yet — out of scope here.
      if (input === 'x' && linkedAccounts[acctCursor] && !linkedAccounts[acctCursor].awaitingFirstSync) {
        setAcctMode('confirm-delete');
        return;
      }

      if (input === 's' && syncStatus !== 'syncing') { forceSync(); return; }
      return;
    }

    // ── Links view ────────────────────────────────────────────────────────────
    // Connection-level actions live here rather than on an account row: they all
    // act on the item, and doing them from an account row implied a scope the
    // action never had.
    if (mainView === 'links') {
      if (linksMode === 'confirm-refresh') {
        if (key.escape || input === 'n') { setLinksMode('list'); return; }
        if (input === 'y' && linkedItems[itemCursor]) { startRefresh(linkedItems[itemCursor]); return; }
        // The refresh confirmation points at [d] for the restore case, so accept
        // it here — cancelling first only to press it again is pure friction.
        if (input === 'd' && linkedItems[itemCursor]) { setLinksMode('confirm-delete-cursor'); return; }
        return;
      }
      if (linksMode === 'confirm-delete-cursor') {
        if (key.escape || input === 'n') { setLinksMode('list'); return; }
        if (input === 'y' && linkedItems[itemCursor]) { startDeleteCursor(linkedItems[itemCursor]); return; }
        return;
      }
      // Esc stops an in-flight refresh rather than leaving the tab — the poll
      // runs for minutes and this is the only way out of it.
      if (key.escape && refreshAbortRef.current) { refreshAbortRef.current.abort(); return; }
      if (key.escape) { setMainView('accounts'); return; }
      if (key.tab) { setMainView('add-data'); return; }
      if (key.upArrow)   { setItemCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setItemCursor((c) => Math.min(linkedItems.length - 1, c + 1)); return; }
      // Update link goes straight to Plaid in update mode: it re-authorizes this
      // connection, so there's no history window to ask about (that's fixed when
      // the item is created) and no new accounts or transactions to create.
      if (input === 'u' && linkedItems[itemCursor]) {
        setMainView('add-data');
        setAddStep('link-plaid');
        startPlaidLink(defaultDays, linkedItems[itemCursor].item_id);
        return;
      }
      // Confirmed rather than immediate: Plaid bills per /transactions/refresh
      // call. Also worth the gate because [r] was "repair link" one release ago
      // — muscle memory lands on a confirmation, not a charge. Skipped while a
      // row awaits its first sync: that sync fetches the same window for free.
      if (input === 'r' && linkedItems[itemCursor] && !linkedItems[itemCursor].awaitingFirstSync && syncStatus !== 'syncing') {
        setLinksMode('confirm-refresh');
        return;
      }
      // Confirmed because it is destructive in one direction: replaying the feed
      // resurrects transactions the user deleted on purpose. Costs nothing at
      // Plaid, so the gate is about the surprise, not the bill. Skipped while a
      // row awaits its first sync — that sync starts from scratch already.
      if (input === 'd' && linkedItems[itemCursor] && !linkedItems[itemCursor].awaitingFirstSync && syncStatus !== 'syncing') {
        setLinksMode('confirm-delete-cursor');
        return;
      }
      if (input === 's' && syncStatus !== 'syncing') { forceSync(); return; }
      return;
    }

    // ── Dupes view ────────────────────────────────────────────────────────────
    if (mainView === 'dupes') {
      if (key.escape) { setMainView('accounts'); return; }
      if (key.tab) { setMainView('accounts'); return; }
      if (key.upArrow)   { setDupeCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setDupeCursor((c) => Math.min(dupes.length - 1, c + 1)); return; }
      if (input === 'x' && dupes[dupeCursor]) {
        void deleteDuplicate(dupes[dupeCursor].csvId).then(() => {
          void getCsvPlaidDupeCandidates().then((next) => {
            setDupes(next);
            setDupeCursor((c) => Math.min(c, Math.max(0, next.length - 1)));
          });
        });
        return;
      }
      if (input === 'X') {
        deleteAllDuplicates(dupes.map((p) => p.csvId));
        setDupes([]);
        setDupeCursor(0);
        return;
      }
      return;
    }

    // ── Add-data view ──────────────────────────────────────────────────────────
    if (addStep === 'landing') {
      if (key.escape) { setMainView('accounts'); return; }
      if (key.tab) { setMainView('dupes'); return; }
      if (input === 'l') { setDaysInput(String(defaultDays)); setDaysError(''); setAddStep('link-days'); return; }
      if (input === 'c') { setAddStep('file'); return; }
      if (input === 'm') { setManualName(''); setAddStep('manual-name'); return; }
      if (input === 's' && syncStatus !== 'syncing') { forceSync(); return; }
      return;
    }

    if (addStep === 'link-days') {
      if (key.escape) { setAddStep('landing'); setDaysError(''); return; }
      if (key.return) {
        const n = parseInt(daysInput, 10);
        if (isNaN(n) || n < MIN_DAYS_REQUESTED || n > MAX_DAYS_REQUESTED) { setDaysError(`Enter a whole number from ${MIN_DAYS_REQUESTED} to ${MAX_DAYS_REQUESTED}`); return; }
        setDaysError('');
        setAddStep('link-plaid');
        startPlaidLink(n);
        return;
      }
      if (key.backspace || key.delete) { setDaysInput((v) => v.slice(0, -1)); setDaysError(''); return; }
      if (input && /^[0-9]+$/.test(input) && !key.ctrl && !key.meta && daysInput.length <= 3) { setDaysInput((v) => v + input); setDaysError(''); return; }
      return;
    }

    if (addStep === 'link-plaid') {
      if (key.return && (linkStatus === 'done' || linkStatus === 'error')) {
        setLinkStatus('idle');
        setLinkMsg('');
        setMainView('accounts');
        setAddStep('landing');
      }
      return;
    }

    if (addStep === 'file') {
      if (key.escape) { setAddStep('landing'); return; }
      if (key.return) { tryLoadFile(filePath); return; }
      if (key.backspace || key.delete) { setFilePath((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setFilePath((p) => p + input);
      return;
    }

    if (addStep === 'map-date' || addStep === 'map-name' || addStep === 'map-amount' || addStep === 'map-debit' || addStep === 'map-credit') {
      if (key.escape) { setAddStep('landing'); return; }
      if (key.upArrow) setColCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setColCursor((c) => Math.min(headers.length - 1, c + 1));
      if (key.return) {
        if (addStep === 'map-date')   { setDateCol(colCursor); setColCursor(nameCol ?? 0); setAddStep('map-name'); }
        else if (addStep === 'map-name')   { setNameCol(colCursor); setAddStep('map-amount-mode'); }
        else if (addStep === 'map-amount') { setAmountCol(colCursor); setAddStep('direction'); }
        else if (addStep === 'map-debit')  { setDebitCol(colCursor); setColCursor(0); setAddStep('map-credit'); }
        else if (addStep === 'map-credit') {
          setCreditCol(colCursor);
          void getCsvAccounts().then((accts) => { setCsvAccounts(accts); setAddStep('account'); });
        }
      }
      return;
    }

    if (addStep === 'map-amount-mode') {
      if (key.escape) { setAddStep('landing'); return; }
      if (input === 's') { setAmountMode('single'); setColCursor(0); setAddStep('map-amount'); }
      if (input === 'd') { setAmountMode('split'); setColCursor(0); setAddStep('map-debit'); }
      return;
    }

    if (addStep === 'direction') {
      if (key.escape) { setAddStep('landing'); return; }
      if (input === 'i') { setPositiveIsInflow(true);  void getCsvAccounts().then((a) => { setCsvAccounts(a); setAddStep('account'); }); }
      if (input === 'o') { setPositiveIsInflow(false); void getCsvAccounts().then((a) => { setCsvAccounts(a); setAddStep('account'); }); }
      return;
    }

    if (addStep === 'account') {
      if (key.escape) { setAddStep('landing'); return; }
      if (key.upArrow)   setCsvAccountCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCsvAccountCursor((c) => Math.min(csvAccounts.length - 1, c + 1));
      if (input === 'n') { setNewAcctName(''); setNewAcctType('credit'); setNewAcctSubtype('credit card'); setNewAcctField('type'); setAddStep('new-acct-name'); return; }
      if (key.return) setAddStep('confirm');
      return;
    }

    if (addStep === 'new-acct-name') {
      if (key.escape) { setAddStep('account'); return; }
      if (key.return && newAcctName.trim()) { setNewAcctField('type'); setAddStep('new-acct-type'); return; }
      if (key.backspace || key.delete) { setNewAcctName((v) => v.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setNewAcctName((v) => v + input); return; }
      return;
    }

    if (addStep === 'new-acct-type') {
      if (key.escape) { setAddStep('new-acct-name'); return; }
      if (key.return) { saveNewAcct(); return; }
      if (key.tab) { setNewAcctField((f) => f === 'type' ? 'subtype' : 'type'); return; }
      if (newAcctField === 'type' && (key.leftArrow || key.rightArrow)) {
        const idx = ACCOUNT_TYPES.indexOf(newAcctType as typeof ACCOUNT_TYPES[number]);
        const next = ACCOUNT_TYPES[(idx + (key.leftArrow ? -1 : 1) + ACCOUNT_TYPES.length) % ACCOUNT_TYPES.length];
        setNewAcctType(next);
        setNewAcctSubtype(SUBTYPES[next]?.[0] ?? '');
        return;
      }
      if (newAcctField === 'subtype') {
        const subtypes = SUBTYPES[newAcctType] ?? [];
        if (subtypes.length > 0 && (key.leftArrow || key.rightArrow)) {
          const idx = subtypes.indexOf(newAcctSubtype);
          setNewAcctSubtype(subtypes[(idx + (key.leftArrow ? -1 : 1) + subtypes.length) % subtypes.length]);
        }
        return;
      }
      return;
    }

    if (addStep === 'confirm') {
      if (key.escape) { setAddStep('landing'); return; }
      if (input === 'y') doImport();
      if (input === 'n') { setAddStep('landing'); }
      return;
    }

    if (addStep === 'done') {
      if (key.return) { setImportResult(null); setAddStep('landing'); setMainView('accounts'); void loadAccounts(); }
      return;
    }

    if (addStep === 'manual-name') {
      if (key.escape) { setAddStep('landing'); setManualName(''); return; }
      if (key.return && manualName.trim()) { setManualValue(''); setManualValueError(''); setAddStep('manual-value'); return; }
      if (key.backspace || key.delete) { setManualName((n) => n.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setManualName((n) => n + input); return; }
      return;
    }

    if (addStep === 'manual-value') {
      if (key.escape) { setAddStep('manual-name'); return; }
      if (key.return) { void saveManualAsset(); return; }
      if (key.backspace || key.delete) { setManualValue((v) => v.slice(0, -1)); setManualValueError(''); return; }
      if (input && !key.ctrl && !key.meta) { setManualValue((v) => v + input); setManualValueError(''); return; }
      return;
    }

    if (addStep === 'manual-done') {
      if (key.return) { setManualName(''); setManualValue(''); setAddStep('landing'); setMainView('accounts'); }
      return;
    }
  }, { isActive: isActive !== false });

  // ─── Render ──────────────────────────────────────────────────────────────────

  const selectedAcct = linkedAccounts[acctCursor];
  const selectedItem = linkedItems[itemCursor];
  // A running refresh owns the Links status line; its text is re-derived every
  // render so the countdown in the waiting step actually counts down.
  const linksStatusLine = refreshProgress ? describeRefreshProgress(refreshProgress) : syncMsg;
  // Placeholders aren't accounts yet, so the footer names them separately
  // rather than inflating the account count.
  const awaitingCount = linkedAccounts.filter((a) => a.awaitingFirstSync).length;
  const realAcctCount = linkedAccounts.length - awaitingCount;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="accounts" showHints={showHints} />

      <Box marginTop={1}>
        <Box gap={3}>
          <Text bold color={mainView === 'accounts' ? C_ACCENT : undefined} dimColor={mainView !== 'accounts'}>Accounts</Text>
          <Text bold color={mainView === 'links' ? C_ACCENT : undefined} dimColor={mainView !== 'links'}>
            Links{failingItems.size > 0 ? <Text color={C_NEGATIVE}> ⚠</Text> : ''}
          </Text>
          <Text bold color={mainView === 'add-data' ? C_ACCENT : undefined} dimColor={mainView !== 'add-data'}>Add Data</Text>
          <Text bold color={mainView === 'dupes' ? C_ACCENT : undefined} dimColor={mainView !== 'dupes'}>
            Dupes{dupesLoading && dupes.length === 0 ? ' …' : dupes.length > 0 ? ` (${dupes.length})` : ''}
          </Text>
          {showHints && <Text dimColor>[Tab]</Text>}
        </Box>
      </Box>
      {showHints && <Box justifyContent="flex-end">
        <Text dimColor>
          {mainView === 'accounts' && acctMode === 'list'
            ? `↑↓ select  ·  Enter edit${selectedAcct?.id.startsWith('manual-') ? '  ·  [v] update value' : ''}  ·  [x] delete  ·  [s] sync`
            : mainView === 'accounts' && acctMode === 'edit'
            ? '↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel'
            : mainView === 'links' && refreshProgress
            ? 'Esc stop checking'
            : mainView === 'links'
            ? '↑↓ select  ·  [u] update link  ·  [r] refresh  ·  [s] sync'
            : mainView === 'dupes'
            ? '↑↓ select  ·  [x] delete CSV copy  ·  [X] delete all'
            : ''}
        </Text>
      </Box>}

      <Box marginTop={1}><Divider /></Box>

      {/* ── Accounts view ─────────────────────────────────────────────── */}
      {mainView === 'accounts' && (
        <>
          {linkedAccounts.length === 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>No accounts linked yet.</Text>
              <Text dimColor>Tab → Add Data → [l] link a bank or [c] import CSV.</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {linkedAccounts.map((acct, i) => {
                const isSelected = i === acctCursor;
                const raw = acct.subtype ?? acct.type;
                // A placeholder has no real subtype and no mask — leave both blank
                // rather than claiming 'other'.
                const label = (acct.awaitingFirstSync ? '⋯' : (SUBTYPE_DISPLAY[raw] ?? raw)).padEnd(14);
                const institution = acct.institution_name ? truncate(acct.institution_name, acctInstW) : '';
                return (
                  <SelectableRow key={acct.id} selected={isSelected}>
                    <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>
                      {truncate(acct.nickname ?? acct.name, acctNameW).padEnd(acctNameW)}
                    </Text>
                    <Text dimColor={!isSelected} color={isSelected && acct.nickname ? C_MANUAL : undefined}>{acct.nickname ? '✎' : ' '}</Text>
                    <Text dimColor>{acct.mask ? `···${acct.mask}` : '      '}</Text>
                    <Text dimColor>{label}</Text>
                    <Text dimColor>{institution.padEnd(acctInstW)}</Text>
                    {/* Order matters: a failure outranks everything, then the
                        not-yet-synced placeholder, then the item's real sync time,
                        then the balance-date fallback for accounts with no item
                        (manual/CSV). */}
                    <Text dimColor>
                      {acct.item_id && failingItems.has(acct.item_id)
                        ? <Text color={C_NEGATIVE}>⚠ sync failed</Text>
                        : acct.awaitingFirstSync
                        ? <Text color={C_WARNING}>◷ awaiting first sync</Text>
                        : acct.item_last_synced_at !== null
                        ? <Text>synced <Text color={isSelected ? C_POSITIVE : undefined}>{fmtSyncedAt(acct.item_last_synced_at)}</Text></Text>
                        : acct.last_synced
                        ? <Text>synced <Text color={isSelected ? C_POSITIVE : undefined}>{fmtDate(acct.last_synced)}</Text></Text>
                        : <Text color={C_WARNING}>not synced</Text>
                      }
                    </Text>
                    {acct.owner && <Text color={isSelected ? C_MANUAL : undefined} dimColor={!isSelected}>{acct.owner}</Text>}
                    {acct.excluded && <Text dimColor>⊘ excl</Text>}
                  </SelectableRow>
                );
              })}
            </Box>
          )}

          <Box marginTop={1}><Divider /></Box>
          <Text dimColor>
            {realAcctCount} account{realAcctCount !== 1 ? 's' : ''}
            {awaitingCount > 0 && ` · ${awaitingCount} institution${awaitingCount !== 1 ? 's' : ''} awaiting first sync`}
          </Text>
          {syncMsg && <Text color={syncStatus === 'syncing' ? C_WARNING : syncStatus === 'error' ? C_NEGATIVE : C_POSITIVE}>{syncMsg}<Text dimColor>{syncElapsed}</Text></Text>}
          {acctMsg && <Text color={C_POSITIVE}>{acctMsg}</Text>}
          {acctErr && <Text color={C_NEGATIVE}>{acctErr}</Text>}

          {/* Confirm-delete panel */}
          {acctMode === 'confirm-delete' && selectedAcct && (
            <ModalPanel borderColor={C_NEGATIVE}>
              <Text bold color={C_NEGATIVE}>Delete account — this cannot be undone</Text>
              <Box marginTop={1} flexDirection="column">
                <Text><Text color={C_ACCENT}>{selectedAcct.nickname ?? selectedAcct.name}</Text>  {selectedAcct.mask ? `···${selectedAcct.mask}` : ''}</Text>
                {selectedAcct.id.startsWith('manual-')
                  ? <Text dimColor>Removes this asset and its balance history.</Text>
                  : <Text dimColor>Removes this account, all its transactions, and balance history.</Text>
                }
              </Box>
              <Box marginTop={1} gap={4}>
                <Text color={C_NEGATIVE}>[y] Yes, delete</Text>
                <Text color={C_POSITIVE}>[n] / Esc cancel</Text>
              </Box>
            </ModalPanel>
          )}

          {/* Update-value panel */}
          {acctMode === 'update-value' && selectedAcct && (
            <ModalPanel title={`Update value: ${selectedAcct.name}`} borderColor={C_WARNING}>
              <Box marginTop={1} gap={1}><Text>New value: $</Text><TextInput value={updateValueInput} color={C_WARNING} /></Box>
              {updateValueError && <Text color={C_NEGATIVE}>{updateValueError}</Text>}
              <Box marginTop={1}><Text dimColor>Enter save · Esc cancel</Text></Box>
            </ModalPanel>
          )}

          {/* Unified edit panel */}
          {acctMode === 'edit' && selectedAcct && (() => {
            const isDebt = editType === 'credit' || editType === 'loan';
            // Institution is often the only thing distinguishing two same-named
            // accounts at different banks (a "Plaid Checking" at each), so the
            // panel names it alongside the mask.
            return (
              <ModalPanel title={`Edit: ${selectedAcct.name}${selectedAcct.mask ? ` ···${selectedAcct.mask}` : ''}${selectedAcct.institution_name ? `  ·  ${selectedAcct.institution_name}` : ''}`}>
                <Box marginTop={1} flexDirection="column" gap={1}>
                  <EditTextField label="Nickname" labelWidth={10} active={editField === 'nickname'} value={editNickname} color={C_WARNING} placeholder="none" emptyText="none" />
                  {ownerMembers.length > 0
                    ? <EditToggleField label="Owner" labelWidth={10} active={editField === 'owner'} value={editOwner || 'Unassigned'} valueColor={C_MANUAL} />
                    : (
                      <Box gap={2}>
                        <Text color={C_NEUTRAL}>{'Owner'.padEnd(10)}</Text>
                        <Text dimColor>Add household members in Settings [0]</Text>
                      </Box>
                    )}
                  <EditToggleField label="Type" labelWidth={10} active={editField === 'type'} value={editType} />
                  <EditToggleField label="Subtype" labelWidth={10} active={editField === 'subtype'} value={editSubtype || '—'} valueColor={C_DIM} />
                  {isDebt && <EditTextField label="APR %" labelWidth={10} active={editField === 'apr'} value={editApr} color={C_WARNING} placeholder="0.0" />}
                  <EditToggleField label="Net worth" labelWidth={10} active={editField === 'excluded'} value={editExcluded ? 'Excluded' : 'Included'} valueColor={editExcluded ? C_DIM : C_POSITIVE} />
                </Box>
                <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
              </ModalPanel>
            );
          })()}
        </>
      )}

      {/* ── Links view ────────────────────────────────────────────────── */}
      {mainView === 'links' && (
        <Box flexDirection="column" marginTop={1}>
          {linkedItems.length === 0 ? (
            <>
              <Text dimColor>No bank connections yet.</Text>
              <Text dimColor>Tab → Add Data → [l] link a bank.</Text>
            </>
          ) : (
            <>
              {linkedItems.map((item, i) => {
                const isSelected = i === itemCursor;
                const failing = failingItems.has(item.item_id);
                return (
                  <SelectableRow key={item.item_id} selected={isSelected}>
                    <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>
                      {truncate(item.institution_name ?? '(unknown institution)', 24).padEnd(24)}
                    </Text>
                    <Text dimColor>
                      {`${item.account_count} account${item.account_count !== 1 ? 's' : ''}`.padEnd(12)}
                    </Text>
                    <Text dimColor>
                      {/* Locked at link time — the only way to widen it is a new item. */}
                      {(item.days_requested ? `${item.days_requested}d history` : '90d (default)').padEnd(16)}
                    </Text>
                    <Text dimColor>
                      {failing
                        ? <Text color={C_NEGATIVE}>⚠ sync failed</Text>
                        : item.awaitingFirstSync
                        ? <Text color={C_WARNING}>◷ awaiting first sync</Text>
                        : item.last_synced_at !== null
                        ? <Text>synced <Text color={isSelected ? C_POSITIVE : undefined}>{fmtSyncedAt(item.last_synced_at)}</Text></Text>
                        : <Text color={C_WARNING}>never synced</Text>}
                    </Text>
                    {/* No cursor means the next sync re-downloads the item's whole history. */}
                    {!item.hasCursor && !item.awaitingFirstSync && <Text dimColor>· sync cursor cleared</Text>}
                  </SelectableRow>
                );
              })}

              <Box marginTop={1}><Divider /></Box>
              <Text dimColor>
                {linkedItems.length} connection{linkedItems.length !== 1 ? 's' : ''}
                {failingItems.size > 0 && <Text color={C_NEGATIVE}>  ·  {failingItems.size} failing</Text>}
              </Text>
              {linksStatusLine && <Text color={syncStatus === 'syncing' ? C_WARNING : syncStatus === 'error' ? C_NEGATIVE : C_POSITIVE}>{linksStatusLine}<Text dimColor>{syncElapsed}</Text></Text>}

              {linksMode === 'confirm-refresh' && selectedItem && (
                <ModalPanel borderColor={C_WARNING}>
                  <Text bold color={C_WARNING}>Refresh transactions — Plaid charges for each refresh</Text>
                  <Box marginTop={1} flexDirection="column">
                    <Text>
                      <Text color={C_ACCENT}>{selectedItem.institution_name ?? '(unknown institution)'}</Text>
                      <Text dimColor>  — all {selectedItem.account_count} account{selectedItem.account_count !== 1 ? 's' : ''} on this connection</Text>
                    </Text>
                    <Text dimColor>Asks your bank to go look for new transactions right now.</Text>
                    <Box marginTop={1} flexDirection="column">
                      {/* Naming the boundary is what makes the steer below land: past
                          about a day, Plaid already has it, which is the [d] case. */}
                      <Text dimColor>Only worth it for transactions from the last day or so — Plaid already has anything older.</Text>
                      {/* The window is fixed at item creation and update mode cannot
                          widen it, so name it here rather than leaving the limit abstract. */}
                      <Text dimColor>
                        It can't reach past this connection's {selectedItem.days_requested ? `${selectedItem.days_requested}-day` : '90-day'} history window.
                      </Text>
                      <Text dimColor>
                        Then checks for new transactions {POLL_DELAYS_MS.length} times over about {Math.round(POLL_DELAYS_MS.reduce((a, b) => a + b, 0) / 60000)} minutes. Esc stops the checks.
                      </Text>
                    </Box>
                    {/* Redirects the restore case, and says why refresh is the wrong
                        tool for it — otherwise it reads as an arbitrary preference
                        between two buttons. Undimmed headline so it separates from
                        the four dim lines above. */}
                    <Box marginTop={1} flexDirection="column">
                      <Text>Trying to get back transactions you deleted, or an account you removed?</Text>
                      <Text dimColor>Refresh won't do it — it only fetches what your bank hasn't reported yet.</Text>
                      {/* Its own line: wrapping mid-phrase would split the key from
                          the label it names. */}
                      <Text dimColor>
                        Press <Text color={C_POSITIVE}>[d] delete sync cursor</Text> instead — it re-downloads everything Plaid holds, free.
                      </Text>
                    </Box>
                  </Box>
                  <Box marginTop={1} gap={4}>
                    <Text color={C_WARNING}>[y] Yes, refresh</Text>
                    <Text color={C_POSITIVE}>[d] delete sync cursor</Text>
                    <Text color={C_POSITIVE}>[n] / Esc cancel</Text>
                  </Box>
                </ModalPanel>
              )}

              {linksMode === 'confirm-delete-cursor' && selectedItem && (
                <ModalPanel borderColor={C_WARNING}>
                  <Text bold color={C_WARNING}>Delete sync cursor and resync</Text>
                  <Box marginTop={1} flexDirection="column">
                    <Text>
                      <Text color={C_ACCENT}>{selectedItem.institution_name ?? '(unknown institution)'}</Text>
                      <Text dimColor>  — all {selectedItem.account_count} account{selectedItem.account_count !== 1 ? 's' : ''} on this connection</Text>
                    </Text>
                    <Text dimColor>
                      Forgets how far we've read Plaid's change feed, so the next sync re-downloads
                      every transaction Plaid currently holds. Free — it costs only the time to resync.
                    </Text>
                    <Box marginTop={1} flexDirection="column">
                      <Text dimColor>Existing rows are updated in place, not duplicated, and your categories and tags are kept.</Text>
                      {/* deleteTransaction leaves no tombstone, so the replayed feed
                          resurrects deliberate deletions. The one destructive thing
                          this does, hence undimmed. */}
                      <Text>Transactions you deleted by hand will come back.</Text>
                      <Text dimColor>Transactions Plaid no longer has will not.</Text>
                    </Box>
                  </Box>
                  <Box marginTop={1} gap={4}>
                    <Text color={C_WARNING}>[y] Yes, delete cursor and resync</Text>
                    <Text color={C_POSITIVE}>[n] / Esc cancel</Text>
                  </Box>
                </ModalPanel>
              )}

              <Box marginTop={1} flexDirection="column">
                {/* Padded to the longest label so the em dashes line up. */}
                <Text dimColor>[u] update link        — update creds for link, keeping its accounts and transactions</Text>
                <Text dimColor>[d] delete sync cursor — re-download this connection's full history (free)</Text>
                <Text dimColor>[r] refresh            — ask this bank for new transactions now (Plaid charges)</Text>
                <Text dimColor>[s] sync               — re-sync every connection now</Text>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* ── Dupes view ────────────────────────────────────────────────── */}
      {mainView === 'dupes' && (
        <Box flexDirection="column" marginTop={1}>
          {dupesLoading && dupes.length === 0 ? (
            <Text color={C_WARNING}>⟳ Checking for duplicates… <Text dimColor>(scans every transaction; can take a while on a large history)</Text></Text>
          ) : dupes.length === 0 ? (
            <Text color={C_POSITIVE}>No duplicate candidates found.</Text>
          ) : (
            dupes.map((pair, i) => {
              const isSelected = i === dupeCursor;
              return (
                <Box key={pair.csvId} flexDirection="column" marginBottom={1}>
                  <Box gap={2}>
                    <Text color={isSelected ? C_ACCENT : undefined}>{isSelected ? '▶' : ' '}</Text>
                    <Text dimColor>{truncate(pair.accountName, 20).padEnd(20)}</Text>
                    <Text color={C_WARNING}>CSV</Text>
                    <Text dimColor>{pair.csvDate}</Text>
                    <Text color={isSelected ? C_ACCENT : undefined}>{truncate(pair.csvName, 30).padEnd(30)}</Text>
                    <Text color={C_NEGATIVE}>${Math.abs(pair.csvAmount).toFixed(2)}</Text>
                  </Box>
                  <Box gap={2}>
                    <Text> </Text>
                    <Text dimColor>{''.padEnd(20)}</Text>
                    <Text color={C_POSITIVE}>PLI</Text>
                    <Text dimColor>{pair.plaidDate}</Text>
                    <Text dimColor>{truncate(pair.plaidName, 30)}</Text>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>
      )}

      {/* ── Add-data view ─────────────────────────────────────────────── */}
      {mainView === 'add-data' && (
        <>
          {addStep === 'landing' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Box flexDirection="column" gap={1} marginTop={1}>
                <Text color={C_ACCENT}>[l] Link a bank account  <Text dimColor>Opens Plaid in your browser</Text></Text>
                <Text color={C_ACCENT}>[c] Import CSV file      <Text dimColor>Upload a statement export</Text></Text>
                <Text color={C_ACCENT}>[m] Manual asset         <Text dimColor>House, car, or other asset</Text></Text>
                <Text color={syncStatus === 'syncing' ? C_WARNING : C_ACCENT}>
                  [s] Force sync          <Text dimColor>Re-sync from Plaid now</Text>
                </Text>
              </Box>
              {syncMsg && <Box marginTop={1}><Text color={syncStatus === 'syncing' ? C_WARNING : syncStatus === 'error' ? C_NEGATIVE : C_POSITIVE}>{syncMsg}<Text dimColor>{syncElapsed}</Text></Text></Box>}
              <Box marginTop={1}><Text dimColor>Tab or Esc to go back</Text></Box>
            </Box>
          )}

          {addStep === 'link-days' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Transaction History Window</Text>
              <Text dimColor>How many days of history should Plaid fetch? (30–{MAX_DAYS_REQUESTED}, default {defaultDays})</Text>
              <Text dimColor>Default comes from the start date set during setup (plus a small buffer for timezone safety). This is locked in when the bank is linked and can only be changed if you recreate the link later.</Text>
              <Box gap={1}><Text>Days: </Text><TextInput value={daysInput} /></Box>
              {daysError && <Text color={C_NEGATIVE}>{daysError}</Text>}
              <Text dimColor>Enter to continue · Esc back</Text>
            </Box>
          )}

          {addStep === 'link-plaid' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>{linkMode === 'update' ? 'Update Link Credentials' : 'Link Bank Account'}</Text>
              <Text color={linkStatus === 'done' ? C_POSITIVE : linkStatus === 'error' ? C_NEGATIVE : C_WARNING}>
                {linkStatus === 'running' ? '⟳ ' : ''}{linkMsg}<Text dimColor>{linkElapsed}</Text>
              </Text>
              {linkStatus === 'running' && linkUrl && (
                <Text>Open this link if your browser didn't: <Text color={C_ACCENT}>{linkUrl}</Text></Text>
              )}
              {linkStatus === 'running' && (
                <Text dimColor>Complete the Plaid flow in your browser, then return here.</Text>
              )}
              {linkStatus === 'running' && linkMode === 'update' && (
                <Text dimColor>Your existing accounts and transactions are kept — sign in with the same bank.</Text>
              )}
              {/* The post-link sync runs while this panel is still on screen, so
                  its steps have to be reported here too — otherwise the panel
                  shows a finished link message with a counter ticking beside it
                  and no sign of what is actually running. */}
              {syncMsg && (
                <Text color={syncStatus === 'syncing' ? C_WARNING : syncStatus === 'error' ? C_NEGATIVE : C_POSITIVE}>
                  {syncStatus === 'syncing' ? '⟳ ' : ''}{syncMsg}<Text dimColor>{syncElapsed}</Text>
                </Text>
              )}
              {(linkStatus === 'done' || linkStatus === 'error') && (
                <Text dimColor>Press Enter to return.</Text>
              )}
            </Box>
          )}

          {addStep === 'file' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text dimColor>Enter the path to your CSV file:</Text>
              <Box gap={1}><Text>Path: </Text><TextInput value={filePath} color={C_WARNING} /></Box>
              {fileError && <Text color={C_NEGATIVE}>{fileError}</Text>}
              <Text dimColor>Press Enter to load · Esc back</Text>
            </Box>
          )}

          {(addStep === 'map-date' || addStep === 'map-name' || addStep === 'map-amount' || addStep === 'map-debit' || addStep === 'map-credit') && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>
                {addStep === 'map-date'   && 'Which column is the DATE?'}
                {addStep === 'map-name'   && 'Which column is the DESCRIPTION/NAME?'}
                {addStep === 'map-amount' && 'Which column is the AMOUNT?'}
                {addStep === 'map-debit'  && 'Which column is the DEBIT (money out)?'}
                {addStep === 'map-credit' && 'Which column is the CREDIT (money in)?'}
              </Text>
              <Text dimColor>↑↓ select · Enter confirm · Esc cancel</Text>
              <Box flexDirection="column" marginTop={1}>
                {headers.map((h, i) => {
                  const sample = csvRows.slice(0, 3).map((r) => r[i] ?? '').filter(Boolean).join(', ');
                  return (
                    <SelectableRow key={i} selected={i === colCursor}>
                      <Text color={i === colCursor ? C_ACCENT : C_NEUTRAL} dimColor={i !== colCursor}>
                        {h.padEnd(24)}
                        <Text dimColor>  {truncate(sample, 36)}</Text>
                      </Text>
                    </SelectableRow>
                  );
                })}
              </Box>
              <Box marginTop={1} gap={3}>
                {dateCol !== null   && <Text dimColor>date: <Text color={C_POSITIVE}>{headers[dateCol]}</Text></Text>}
                {nameCol !== null   && <Text dimColor>name: <Text color={C_POSITIVE}>{headers[nameCol]}</Text></Text>}
                {amountCol !== null && <Text dimColor>amount: <Text color={C_POSITIVE}>{headers[amountCol]}</Text></Text>}
                {debitCol !== null  && <Text dimColor>debit: <Text color={C_POSITIVE}>{headers[debitCol]}</Text></Text>}
                {creditCol !== null && <Text dimColor>credit: <Text color={C_POSITIVE}>{headers[creditCol]}</Text></Text>}
              </Box>
            </Box>
          )}

          {addStep === 'map-amount-mode' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>How is the amount structured?</Text>
              <Text color={C_ACCENT}>[s] Single column  <Text dimColor>(one column, positive or negative)</Text></Text>
              <Text color={C_ACCENT}>[d] Debit / Credit  <Text dimColor>(two separate columns)</Text></Text>
            </Box>
          )}

          {addStep === 'direction' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>In column <Text color={C_WARNING}>"{headers[amountCol!]}"</Text>, does a positive number mean...</Text>
              <Text color={C_ACCENT}>[i] Inflow  <Text dimColor>(money coming in)</Text></Text>
              <Text color={C_ACCENT}>[o] Outflow <Text dimColor>(money going out)</Text></Text>
            </Box>
          )}

          {addStep === 'account' && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Which account do these transactions belong to?</Text>
              <Text dimColor>↑↓ select · Enter confirm · [n] new account</Text>
              <Box flexDirection="column" marginTop={1}>
                {csvAccounts.map((acct, i) => (
                  <SelectableRow key={acct.id} selected={i === csvAccountCursor}>
                    <Text color={i === csvAccountCursor ? C_ACCENT : C_NEUTRAL} dimColor={i !== csvAccountCursor}>
                      {acct.name}
                      <Text dimColor>  {acct.mask ? `···${acct.mask}` : ''}</Text>
                    </Text>
                  </SelectableRow>
                ))}
              </Box>
              {csvAccounts.length === 0 && <Text dimColor>No accounts yet — press [n] to create one.</Text>}
            </Box>
          )}

          {addStep === 'new-acct-name' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>New Account — Name</Text>
              <Text dimColor>Type a name for this account (e.g. "Venture X", "Freedom Unlimited")</Text>
              <Box marginTop={1} gap={1}><Text>Name: </Text><TextInput value={newAcctName} color={C_WARNING} /></Box>
              <Text dimColor>Enter to continue · Esc back</Text>
            </Box>
          )}

          {addStep === 'new-acct-type' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>New Account — Type</Text>
              <Text dimColor>Account: <Text color={C_ACCENT}>{newAcctName}</Text></Text>
              <Box flexDirection="column" marginTop={1} gap={1}>
                <Box gap={2}>
                  <Text color={newAcctField === 'type' ? C_ACCENT : C_NEUTRAL}>
                    {newAcctField === 'type' ? '▶ ' : '  '}Type
                  </Text>
                  <Text color={newAcctField === 'type' ? C_ACCENT : undefined}>
                    {'← '}{newAcctType}{'  →'}
                  </Text>
                </Box>
                <Box gap={2}>
                  <Text color={newAcctField === 'subtype' ? C_ACCENT : C_NEUTRAL}>
                    {newAcctField === 'subtype' ? '▶ ' : '  '}Subtype
                  </Text>
                  <Text color={newAcctField === 'subtype' ? C_ACCENT : C_DIM}>
                    {'← '}{newAcctSubtype || '—'}{'  →'}
                  </Text>
                </Box>
              </Box>
              <Text dimColor>Tab switch field · ← → change · Enter save · Esc back</Text>
            </Box>
          )}

          {addStep === 'confirm' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Ready to import</Text>
              <Text>File: <Text color={C_WARNING}>{filePath}</Text></Text>
              <Text>Account: <Text color={C_ACCENT}>{csvAccounts[csvAccountCursor]?.name}</Text></Text>
              <Text>{csvRows.length} rows · sample preview:</Text>
              <Box flexDirection="column" marginTop={1}>
                <Box gap={2}>
                  <Text dimColor>{'DATE'.padEnd(12)}</Text>
                  <Text dimColor>{'DESCRIPTION'.padEnd(30)}</Text>
                  <Text dimColor>AMOUNT</Text>
                </Box>
                {csvRows.slice(0, 5).map((row, i) => {
                  const { date, name, amount } = previewRow(row);
                  return (
                    <Box key={i} gap={2}>
                      <Text>{date.padEnd(12)}</Text>
                      <Text>{name.padEnd(30)}</Text>
                      <Text color={C_WARNING}>{amount}</Text>
                    </Box>
                  );
                })}
              </Box>
              <Box marginTop={1} gap={4}>
                <Text color={C_ACCENT}>[y] Import</Text>
                <Text color={C_NEGATIVE}>[n] Cancel</Text>
              </Box>
            </Box>
          )}

          {addStep === 'done' && importResult && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold color={C_POSITIVE}>Import complete</Text>
              <Text>Imported: <Text color={C_POSITIVE}>{importResult.imported}</Text></Text>
              <Text dimColor>Skipped (duplicates/invalid): {importResult.skipped}</Text>
              <Box marginTop={1}><Text dimColor>Press Enter to return</Text></Box>
            </Box>
          )}

          {addStep === 'manual-name' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Manual Asset — Name</Text>
              <Text dimColor>Type a name for this asset (e.g. "House", "Car")</Text>
              <Box marginTop={1} gap={1}><Text>Name: </Text><TextInput value={manualName} color={C_WARNING} /></Box>
              <Text dimColor>Enter to continue · Esc cancel</Text>
            </Box>
          )}

          {addStep === 'manual-value' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Manual Asset — Current Value</Text>
              <Text dimColor>Asset: <Text color={C_ACCENT}>{manualName}</Text></Text>
              <Box marginTop={1} gap={1}><Text>Value: $</Text><TextInput value={manualValue} color={C_WARNING} /></Box>
              {manualValueError && <Text color={C_NEGATIVE}>{manualValueError}</Text>}
              <Text dimColor>Enter to save · Esc back</Text>
            </Box>
          )}

          {addStep === 'manual-done' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold color={C_POSITIVE}>Asset added</Text>
              <Text><Text color={C_ACCENT}>{manualName}</Text> added to your accounts.</Text>
              <Text dimColor>Update its value anytime from the Accounts tab with [v].</Text>
              <Box marginTop={1}><Text dimColor>Press Enter to return</Text></Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
