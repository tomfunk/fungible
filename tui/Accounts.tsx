import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useSetTyping } from './TypingContext.js';
import { useRefreshKey } from './RefreshContext.js';
import { spawn } from 'node:child_process';
import { syncAll } from '../core/sync.js';
import { getCsvPlaidDupeCandidates, type DupePair } from '../core/dedup.js';
import { parseCSV, parseDate } from '../core/csv.js';
import { getLinkedAccounts, getCsvAccounts, type LinkedAccount, type CsvAccount } from '../core/queries.js';
import { getDefaultDaysRequested, MIN_DAYS_REQUESTED, MAX_DAYS_REQUESTED } from '../core/settings.js';
import {
  updateAccountTypeSubtype, updateAccountNickname, updateAccountApr, updateAccountValue,
  createManualAccount, createCsvAccount, deleteAccount, importCsvTransactions, deleteDuplicate, deleteAllDuplicates,
} from '../core/accounts.js';
import type { Screen, TxFilter } from './App.js';
import { truncate, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, MONTHS, SUBTYPE_DISPLAY, C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_ACCENT, C_MANUAL, C_DIM } from './ui.js';
import { ModalPanel, TextInput, SelectableRow, useStatusMessage, PageHeader } from './components/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type MainView = 'accounts' | 'add-data' | 'dupes';
type AcctMode = 'list' | 'edit' | 'update-value' | 'confirm-delete';
type EditField = 'nickname' | 'type' | 'subtype' | 'apr';

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
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [syncMsg, setSyncMsg] = useState('');

  // Add-data / link state
  const [addStep, setAddStep] = useState<AddStep>('landing');
  const [linkStatus, setLinkStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [linkMsg, setLinkMsg] = useState('');
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
  const [editApr, setEditApr] = useState('');

  // Dupes view state
  const [dupes, setDupes] = useState<DupePair[]>([]);
  const [dupeCursor, setDupeCursor] = useState(0);

  const setTyping = useSetTyping();
  const TEXT_INPUT_STEPS = new Set<AddStep>(['link-days', 'file', 'manual-name', 'manual-value', 'new-acct-name']);
  const TEXT_INPUT_MODES = new Set<AcctMode>(['edit', 'update-value']);
  useEffect(() => {
    setTyping(TEXT_INPUT_STEPS.has(addStep) || TEXT_INPUT_MODES.has(acctMode));
  }, [addStep, acctMode]);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // [sel=2] gap [name] gap [✎=1] gap [mask=7] gap [type=14] gap [inst] gap [synced~14]
  // 6 gaps of 2 = 12; fixed: 2+1+7+14+14+12 = 50
  const acctFlex = Math.max(20, inner - 50);
  const acctNameW = Math.max(14, Math.floor(acctFlex * 0.6));
  const acctInstW = Math.max(8,  acctFlex - acctNameW);

  function loadAccounts() {
    void getLinkedAccounts().then(setLinkedAccounts);
    void getCsvPlaidDupeCandidates().then(setDupes);
  }
  useEffect(() => { loadAccounts(); }, [refreshKey]);

  function openEdit(acct: LinkedAccount) {
    const type = acct.type;
    const subtypes = SUBTYPES[type] ?? [];
    const currentSub = acct.subtype ?? '';
    const snapped = subtypes.includes(currentSub) ? currentSub : (subtypes[0] ?? '');
    setEditType(type);
    setEditSubtype(snapped);
    setEditNickname(acct.nickname ?? '');
    setEditApr(acct.apr !== null && acct.apr !== undefined ? String(acct.apr) : '');
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
      if (isDebt) await updateAccountApr(acct.id, aprVal !== null && !isNaN(aprVal) ? aprVal : null);
      setAcctMode('list');
      showAcctMsg(`Updated ${editNickname.trim() || acct.name}`);
      loadAccounts();
    } catch {
      showAcctErr(`Failed to update ${acct.name}`);
    }
  }

  function forceSync() {
    setSyncStatus('syncing');
    setSyncMsg('Syncing…');
    syncAll(true).then((results) => {
      const added = results.reduce((s, r) => s + r.added, 0);
      setSyncMsg(`Done — ${added} new transaction${added !== 1 ? 's' : ''}`);
      setSyncStatus('done');
      loadAccounts();
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg(''); }, 4000);
    }).catch(() => {
      setSyncMsg('Sync failed');
      setSyncStatus('done');
      setTimeout(() => { setSyncStatus('idle'); setSyncMsg(''); }, 3000);
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
      loadAccounts();
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
      loadAccounts();
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
      loadAccounts();
    } catch {
      setUpdateValueError('Failed to update value — please try again');
    }
  }

  function startPlaidLink(days = 730) {
    setLinkStatus('running');
    setLinkMsg('Opening browser…');
    const node = process.execPath;
    const script = new URL('../scripts/link.ts', import.meta.url).pathname;
    const child = spawn(node, [
      '--no-warnings',
      '--import', 'tsx/esm',
      script,
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PLAID_DAYS_REQUESTED: String(days) },
    });
    child.stdout.on('data', (data: Buffer) => {
      const line = data.toString().trim().split('\n').pop() ?? '';
      if (line) setLinkMsg(line);
    });
    child.stderr.on('data', (data: Buffer) => {
      setLinkStatus('error');
      setLinkMsg(data.toString().trim());
    });
    child.on('close', (code: number) => {
      if (code === 0) {
        setLinkStatus('done');
        setLinkMsg('Bank connected! Press Enter to continue.');
        loadAccounts();
      } else if (code !== null) {
        setLinkStatus('error');
        setLinkMsg(`Process exited with code ${code}. Press Enter to continue.`);
      }
    });
  }

  function tryLoadFile(path: string) {
    try {
      const parsed = parseCSV(path.trim());
      if (!parsed.headers.length) { setFileError('No columns found'); return; }
      setHeaders(parsed.headers);
      setCsvRows(parsed.rows);
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
    }).then((result) => {
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
    // Global nav (only when not deep in a multi-step flow)
    const atTop = (mainView === 'accounts' && acctMode === 'list') || (mainView === 'add-data' && addStep === 'landing');

    if (atTop) {
      if (handleNavKey(input, 'accounts', onNavigate)) return;
    }

    // ── Accounts view ──────────────────────────────────────────────────────────
    if (mainView === 'accounts') {
      if (acctMode === 'edit') {
        if (key.escape) { setAcctMode('list'); return; }
        if (key.return) { void saveEdit(); return; }
        const isDebt = editType === 'credit' || editType === 'loan';
        const editFields: EditField[] = isDebt ? ['nickname', 'type', 'subtype', 'apr'] : ['nickname', 'type', 'subtype'];
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
        if (editField === 'apr') {
          if (key.backspace || key.delete) { setEditApr((v) => v.slice(0, -1)); return; }
          if (input && /^[\d.]$/.test(input) && !key.ctrl && !key.meta) { setEditApr((v) => v + input); return; }
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
      if (key.tab) { setMainView('add-data'); return; }
      if (key.upArrow)   { setAcctCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setAcctCursor((c) => Math.min(linkedAccounts.length - 1, c + 1)); return; }
      if ((input === 'e' || key.return) && linkedAccounts[acctCursor]) {
        openEdit(linkedAccounts[acctCursor]);
        return;
      }
      if (input === 'v' && linkedAccounts[acctCursor]?.id.startsWith('manual-')) {
        setUpdateValueInput('');
        setUpdateValueError('');
        setAcctMode('update-value');
        return;
      }
      if (input === 'x' && linkedAccounts[acctCursor]) { setAcctMode('confirm-delete'); return; }

      if (input === 'r' && linkedAccounts[acctCursor]) {
        setMainView('add-data');
        setDaysInput(String(defaultDays));
        setDaysError('');
        setAddStep('link-days');
        return;
      }
      if (input === 's' && syncStatus === 'idle') { forceSync(); return; }
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
      if (input === 's' && syncStatus === 'idle') { forceSync(); return; }
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
      if (key.return) { setImportResult(null); setAddStep('landing'); setMainView('accounts'); loadAccounts(); }
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

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="accounts" showHints={showHints} />

      <Box marginTop={1}>
        <Box gap={3}>
          <Text bold color={mainView === 'accounts' ? C_ACCENT : undefined} dimColor={mainView !== 'accounts'}>Accounts</Text>
          <Text bold color={mainView === 'add-data' ? C_ACCENT : undefined} dimColor={mainView !== 'add-data'}>Add Data</Text>
          <Text bold color={mainView === 'dupes' ? C_ACCENT : undefined} dimColor={mainView !== 'dupes'}>
            Dupes{dupes.length > 0 ? ` (${dupes.length})` : ''}
          </Text>
          {showHints && <Text dimColor>[Tab]</Text>}
        </Box>
      </Box>
      {showHints && <Box justifyContent="flex-end">
        <Text dimColor>
          {mainView === 'accounts' && acctMode === 'list'
            ? `↑↓ select  ·  Enter/[e] edit${selectedAcct?.id.startsWith('manual-') ? '  ·  [v] update value' : '  ·  [r] repair link'}  ·  [x] delete  ·  [s] sync`
            : mainView === 'accounts' && acctMode === 'edit'
            ? '↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel'
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
                const label = (SUBTYPE_DISPLAY[raw] ?? raw).padEnd(14);
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
                    <Text dimColor>
                      {acct.last_synced
                        ? <Text>synced <Text color={isSelected ? C_POSITIVE : undefined}>{fmtDate(acct.last_synced)}</Text></Text>
                        : <Text color={C_WARNING}>not synced</Text>
                      }
                    </Text>
                  </SelectableRow>
                );
              })}
            </Box>
          )}

          <Box marginTop={1}><Divider /></Box>
          <Text dimColor>{linkedAccounts.length} account{linkedAccounts.length !== 1 ? 's' : ''}</Text>
          {syncMsg && <Text color={syncStatus === 'syncing' ? C_WARNING : C_POSITIVE}>{syncMsg}</Text>}
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
            return (
              <ModalPanel title={`Edit: ${selectedAcct.name}${selectedAcct.mask ? ` ···${selectedAcct.mask}` : ''}`}>
                <Box marginTop={1} flexDirection="column" gap={1}>
                  <Box gap={2}>
                    <Text color={editField === 'nickname' ? C_ACCENT : C_NEUTRAL}>{'Nickname'.padEnd(10)}</Text>
                    <Box>
                      <Text color={editField === 'nickname' ? C_ACCENT : C_NEUTRAL}>{'[ '}</Text>
                      {editField === 'nickname'
                        ? <TextInput value={editNickname} color={C_WARNING} placeholder="none" />
                        : <Text color={editNickname ? undefined : C_DIM}>{editNickname || 'none'}</Text>}
                      <Text color={editField === 'nickname' ? C_ACCENT : C_NEUTRAL}>{' ]'}</Text>
                    </Box>
                  </Box>
                  <Box gap={2}>
                    <Text color={editField === 'type' ? C_ACCENT : C_NEUTRAL}>{'Type'.padEnd(10)}</Text>
                    <Text color={editField === 'type' ? C_ACCENT : undefined}>{'← '}{editType}{'  →'}</Text>
                  </Box>
                  <Box gap={2}>
                    <Text color={editField === 'subtype' ? C_ACCENT : C_NEUTRAL}>{'Subtype'.padEnd(10)}</Text>
                    <Text color={editField === 'subtype' ? C_ACCENT : C_DIM}>{'← '}{editSubtype || '—'}{'  →'}</Text>
                  </Box>
                  {isDebt && (
                    <Box gap={2}>
                      <Text color={editField === 'apr' ? C_ACCENT : C_NEUTRAL}>{'APR %'.padEnd(10)}</Text>
                      <Box>
                        <Text color={editField === 'apr' ? C_ACCENT : C_NEUTRAL}>{'[ '}</Text>
                        {editField === 'apr'
                          ? <TextInput value={editApr} color={C_WARNING} placeholder="0.0" />
                          : <Text color={editApr ? undefined : C_DIM}>{editApr || '—'}</Text>}
                        <Text color={editField === 'apr' ? C_ACCENT : C_NEUTRAL}>{' ]'}</Text>
                      </Box>
                    </Box>
                  )}
                </Box>
                <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
              </ModalPanel>
            );
          })()}
        </>
      )}

      {/* ── Dupes view ────────────────────────────────────────────────── */}
      {mainView === 'dupes' && (
        <Box flexDirection="column" marginTop={1}>
          {dupes.length === 0 ? (
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
              {syncMsg && <Box marginTop={1}><Text color={syncStatus === 'syncing' ? C_WARNING : C_POSITIVE}>{syncMsg}</Text></Box>}
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
              <Text bold>Link Bank Account</Text>
              <Text color={linkStatus === 'done' ? C_POSITIVE : linkStatus === 'error' ? C_NEGATIVE : C_WARNING}>
                {linkStatus === 'running' ? '⟳ ' : ''}{linkMsg}
              </Text>
              {linkStatus === 'running' && (
                <Text dimColor>Complete the Plaid flow in your browser, then return here.</Text>
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
