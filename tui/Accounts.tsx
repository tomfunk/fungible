import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { spawn } from 'node:child_process';
import { db } from '../core/db.js';
import { categorize } from '../core/categorize.js';
import { syncAll } from '../core/sync.js';
import { getCsvPlaidDupeCandidates, type DupePair } from '../core/dedup.js';
import { parseCSV, parseDate, generateTxId } from '../core/csv.js';
import { getLinkedAccounts, getCsvAccounts, type LinkedAccount, type CsvAccount } from '../core/queries.js';
import type { Screen, TxFilter } from './App.js';
import { truncate, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth } from './useTerminalWidth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type MainView = 'accounts' | 'add-data' | 'dupes';
type AcctMode = 'list' | 'edit' | 'update-value' | 'nickname' | 'confirm-delete';
type EditField = 'type' | 'subtype';

type AddStep =
  | 'landing'
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
  | 'manual-done';

const ACCOUNT_TYPES = ['depository', 'investment', 'credit', 'loan', 'other'] as const;

const SUBTYPES: Record<string, string[]> = {
  depository:  ['checking', 'savings', 'money market', 'cd', 'hsa', 'prepaid', 'cash management', 'ebt', 'paypal'],
  investment:  ['brokerage', '401k', 'ira', 'roth', 'roth 401k', '403b', '457b', '529', 'hsa', 'pension', 'mutual fund', 'stock plan', 'sep ira', 'simple ira', 'thrift savings plan', 'ugma', 'utma'],
  credit:      ['credit card', 'paypal'],
  loan:        ['mortgage', 'student', 'auto', 'home equity', 'personal', 'line of credit', 'business', 'other'],
  other:       [],
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string | null): string {
  if (!d) return 'never';
  const dt = new Date(d + 'T12:00:00');
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Accounts({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  // Main view toggle
  const [mainView, setMainView] = useState<MainView>('accounts');

  // Accounts view state
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [acctCursor, setAcctCursor] = useState(0);
  const [acctMode, setAcctMode] = useState<AcctMode>('list');
  const [editField, setEditField] = useState<EditField>('type');
  const [editType, setEditType] = useState('');
  const [editSubtype, setEditSubtype] = useState('');
  const [acctMsg, setAcctMsg] = useState('');

  // Sync state (shared)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [syncMsg, setSyncMsg] = useState('');

  // Add-data / link state
  const [addStep, setAddStep] = useState<AddStep>('landing');
  const [linkStatus, setLinkStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [linkMsg, setLinkMsg] = useState('');

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

  // Update-value mode state
  const [updateValueInput, setUpdateValueInput] = useState('');
  const [updateValueError, setUpdateValueError] = useState('');

  // Nickname mode state
  const [nicknameInput, setNicknameInput] = useState('');

  // Dupes view state
  const [dupes, setDupes] = useState<DupePair[]>([]);
  const [dupeCursor, setDupeCursor] = useState(0);

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // [sel=2] gap [name] gap [mask=7] gap [type=14] gap [inst] gap [synced~14]
  // 5 gaps of 2 = 10; fixed: 2+7+14+14+10 = 47
  const acctFlex = Math.max(20, inner - 47);
  const acctNameW = Math.max(14, Math.floor(acctFlex * 0.6));
  const acctInstW = Math.max(8,  acctFlex - acctNameW);

  function loadAccounts() {
    setLinkedAccounts(getLinkedAccounts());
    setDupes(getCsvPlaidDupeCandidates());
  }
  useEffect(() => { loadAccounts(); }, []);

  function openEdit(acct: LinkedAccount) {
    const type = acct.type;
    const subtypes = SUBTYPES[type] ?? [];
    // Snap to a known subtype if possible, otherwise first option
    const currentSub = acct.subtype ?? '';
    const snapped = subtypes.includes(currentSub) ? currentSub : (subtypes[0] ?? '');
    setEditType(type);
    setEditSubtype(snapped);
    setEditField('type');
    setAcctMode('edit');
  }

  function saveEdit() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    db.prepare('UPDATE accounts SET type = ?, subtype = ? WHERE id = ?')
      .run(editType, editSubtype.trim() || null, acct.id);
    setAcctMode('list');
    setAcctMsg(`Updated ${acct.name}`);
    setTimeout(() => setAcctMsg(''), 2500);
    loadAccounts();
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

  function saveManualAsset() {
    const value = parseFloat(manualValue.replace(/[$,]/g, ''));
    if (isNaN(value) || value < 0) { setManualValueError('Enter a valid positive number'); return; }
    const id = `manual-${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT INTO accounts (id, name, type, subtype) VALUES (?, ?, ?, ?)').run(id, manualName.trim(), 'other', 'manual');
    db.prepare('INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)').run(id, value, today);
    setAddStep('manual-done');
    loadAccounts();
  }

  function deleteAccount() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    db.prepare('DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)').run(acct.id);
    db.prepare('DELETE FROM transactions WHERE account_id = ?').run(acct.id);
    db.prepare('DELETE FROM balance_history WHERE account_id = ?').run(acct.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acct.id);
    setAcctMode('list');
    setAcctCursor((c) => Math.max(0, c - 1));
    setAcctMsg(`Deleted ${acct.nickname ?? acct.name}`);
    setTimeout(() => setAcctMsg(''), 2500);
    loadAccounts();
  }

  function saveNickname() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    const nickname = nicknameInput.trim() || null;
    db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(nickname, acct.id);
    setAcctMode('list');
    setAcctMsg(nickname ? `Nickname set to "${nickname}"` : 'Nickname cleared');
    setTimeout(() => setAcctMsg(''), 2500);
    loadAccounts();
  }

  function saveUpdatedValue() {
    const acct = linkedAccounts[acctCursor];
    if (!acct) return;
    const value = parseFloat(updateValueInput.replace(/[$,]/g, ''));
    if (isNaN(value) || value < 0) { setUpdateValueError('Enter a valid positive number'); return; }
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT OR REPLACE INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)').run(acct.id, value, today);
    setAcctMode('list');
    setAcctMsg(`Updated value for ${acct.name}`);
    setTimeout(() => setAcctMsg(''), 2500);
    loadAccounts();
  }

  function startPlaidLink() {
    setLinkStatus('running');
    setLinkMsg('Opening browser…');
    const node = process.execPath;
    const script = new URL('../scripts/link.ts', import.meta.url).pathname;
    const child = spawn(node, [
      '--experimental-sqlite', '--no-warnings',
      '--import', 'tsx/esm',
      script,
    ], { cwd: new URL('..', import.meta.url).pathname });
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
    const insert = db.prepare(`
      INSERT OR IGNORE INTO transactions (id, account_id, date, name, amount, category, raw_category, pending)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
    `);
    let imported = 0, skipped = 0;
    for (const row of csvRows) {
      const rawDate = row[dateCol!] ?? '';
      const name = row[nameCol!] ?? '';
      let amount: number;
      if (amountMode === 'split') {
        const debit = parseFloat(row[debitCol!] || '0') || 0;
        const credit = parseFloat(row[creditCol!] || '0') || 0;
        amount = debit > 0 ? debit : -credit;
      } else {
        const raw = parseFloat(row[amountCol!] || '0') || 0;
        amount = positiveIsInflow ? -raw : raw;
      }
      if (!rawDate || !name || isNaN(amount)) { skipped++; continue; }
      const date = parseDate(rawDate);
      const category = categorize(name, null, null);
      const id = generateTxId(acct.mask ?? acct.id, date, name, amount);
      const changes = (insert.run(id, acct.id, date, name, amount, category) as any).changes;
      if (changes > 0) imported++; else skipped++;
    }
    setImportResult({ imported, skipped });
    setAddStep('done');
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
        if (key.return) { saveEdit(); return; }
        if (key.tab) {
          setEditField((f) => f === 'type' ? 'subtype' : 'type');
          return;
        }
        if (editField === 'type') {
          if (key.leftArrow || key.rightArrow) {
            const idx = ACCOUNT_TYPES.indexOf(editType as typeof ACCOUNT_TYPES[number]);
            const dir = key.leftArrow ? -1 : 1;
            const nextType = ACCOUNT_TYPES[(idx + dir + ACCOUNT_TYPES.length) % ACCOUNT_TYPES.length];
            setEditType(nextType);
            setEditSubtype(SUBTYPES[nextType]?.[0] ?? '');
          }
          return;
        }
        if (editField === 'subtype') {
          const subtypes = SUBTYPES[editType] ?? [];
          if (subtypes.length > 0) {
            if (key.leftArrow || key.rightArrow) {
              const idx = subtypes.indexOf(editSubtype);
              const dir = key.leftArrow ? -1 : 1;
              setEditSubtype(subtypes[(idx + dir + subtypes.length) % subtypes.length]);
            }
          }
          return;
        }
        return;
      }

      if (acctMode === 'update-value') {
        if (key.escape) { setAcctMode('list'); setUpdateValueInput(''); setUpdateValueError(''); return; }
        if (key.return) { saveUpdatedValue(); return; }
        if (key.backspace || key.delete) { setUpdateValueInput((v) => v.slice(0, -1)); setUpdateValueError(''); return; }
        if (input && !key.ctrl && !key.meta) { setUpdateValueInput((v) => v + input); setUpdateValueError(''); return; }
        return;
      }

      if (acctMode === 'nickname') {
        if (key.escape) { setAcctMode('list'); setNicknameInput(''); return; }
        if (key.return) { saveNickname(); return; }
        if (key.backspace || key.delete) { setNicknameInput((v) => v.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNicknameInput((v) => v + input); return; }
        return;
      }

      if (acctMode === 'confirm-delete') {
        if (key.escape || input === 'n') { setAcctMode('list'); return; }
        if (input === 'y') { deleteAccount(); return; }
        return;
      }

      // list mode
      if (key.escape) { onNavigate('dashboard'); return; }
      if (key.tab) { setMainView('add-data'); return; }
      if (key.upArrow)   { setAcctCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setAcctCursor((c) => Math.min(linkedAccounts.length - 1, c + 1)); return; }
      if (input === 'e' && linkedAccounts[acctCursor]) {
        openEdit(linkedAccounts[acctCursor]);
        return;
      }
      if (input === 'n' && linkedAccounts[acctCursor]) {
        setNicknameInput(linkedAccounts[acctCursor].nickname ?? '');
        setAcctMode('nickname');
        return;
      }
      if (input === 'v' && linkedAccounts[acctCursor]?.id.startsWith('manual-')) {
        setUpdateValueInput('');
        setUpdateValueError('');
        setAcctMode('update-value');
        return;
      }
      if (input === 'd' && linkedAccounts[acctCursor]) { setAcctMode('confirm-delete'); return; }
      if (input === 'r' && linkedAccounts[acctCursor]) {
        setMainView('add-data');
        setAddStep('link-plaid');
        startPlaidLink();
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
      if (input === 'd' && dupes[dupeCursor]) {
        db.prepare('DELETE FROM transactions WHERE id = ?').run(dupes[dupeCursor].csvId);
        const next = getCsvPlaidDupeCandidates();
        setDupes(next);
        setDupeCursor((c) => Math.min(c, Math.max(0, next.length - 1)));
        return;
      }
      if (input === 'D') {
        const ids = dupes.map((p) => p.csvId);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM transactions WHERE id IN (${placeholders})`).run(...ids);
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
      if (input === 'l') { setAddStep('link-plaid'); startPlaidLink(); return; }
      if (input === 'c') { setAddStep('file'); return; }
      if (input === 'm') { setManualName(''); setAddStep('manual-name'); return; }
      if (input === 's' && syncStatus === 'idle') { forceSync(); return; }
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
          const accts = getCsvAccounts(); setCsvAccounts(accts); setAddStep('account');
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
      if (input === 'i') { setPositiveIsInflow(true);  const a = getCsvAccounts(); setCsvAccounts(a); setAddStep('account'); }
      if (input === 'o') { setPositiveIsInflow(false); const a = getCsvAccounts(); setCsvAccounts(a); setAddStep('account'); }
      return;
    }

    if (addStep === 'account') {
      if (key.escape) { setAddStep('landing'); return; }
      if (key.upArrow)   setCsvAccountCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCsvAccountCursor((c) => Math.min(csvAccounts.length - 1, c + 1));
      if (key.return) setAddStep('confirm');
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
      if (key.return) { saveManualAsset(); return; }
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
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">fungible</Text>
        <NavHints current="accounts" showHints={showHints} />
      </Box>

      <Box marginTop={1}>
        <Box gap={3}>
          <Text bold color={mainView === 'accounts' ? 'white' : undefined} dimColor={mainView !== 'accounts'}>Accounts</Text>
          <Text bold color={mainView === 'add-data' ? 'white' : undefined} dimColor={mainView !== 'add-data'}>Add Data</Text>
          <Text bold color={mainView === 'dupes' ? 'white' : undefined} dimColor={mainView !== 'dupes'}>
            Dupes{dupes.length > 0 ? ` (${dupes.length})` : ''}
          </Text>
          {showHints && <Text dimColor>[Tab]</Text>}
        </Box>
      </Box>
      {showHints && <Box justifyContent="flex-end">
        <Text dimColor>
          {mainView === 'accounts' && acctMode === 'list'
            ? `↑↓ select  ·  [e] edit  ·  [n] nickname${selectedAcct?.id.startsWith('manual-') ? '  ·  [v] update value' : '  ·  [r] repair link'}  ·  [d] delete  ·  [s] sync`
            : mainView === 'accounts' && acctMode === 'edit'
            ? 'Tab field  ·  ← → value  ·  Enter save  ·  Esc cancel'
            : mainView === 'dupes'
            ? '↑↓ select  ·  [d] delete CSV copy  ·  [D] delete all'
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
                const label = (acct.subtype ?? acct.type).padEnd(14);
                const institution = acct.institution_name ? truncate(acct.institution_name, acctInstW) : '';
                return (
                  <Box key={acct.id} gap={2}>
                    <Text color={isSelected ? 'cyan' : undefined}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>
                      {truncate(acct.nickname ?? acct.name, acctNameW).padEnd(acctNameW)}
                    </Text>
                    {acct.nickname && <Text dimColor={!isSelected} color={isSelected ? 'yellow' : undefined}>✎</Text>}
                    <Text dimColor>{acct.mask ? `···${acct.mask}` : '      '}</Text>
                    <Text dimColor>{label}</Text>
                    <Text dimColor>{institution.padEnd(acctInstW)}</Text>
                    <Text dimColor>
                      {acct.last_synced
                        ? <Text>synced <Text color={isSelected ? 'green' : undefined}>{fmtDate(acct.last_synced)}</Text></Text>
                        : <Text color="yellow">not synced</Text>
                      }
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          <Box marginTop={1}><Divider /></Box>
          <Text dimColor>{linkedAccounts.length} account{linkedAccounts.length !== 1 ? 's' : ''}</Text>
          {syncMsg && <Text color={syncStatus === 'syncing' ? 'yellow' : 'green'}>{syncMsg}</Text>}
          {acctMsg && <Text color="green">{acctMsg}</Text>}

          {/* Confirm-delete panel */}
          {acctMode === 'confirm-delete' && selectedAcct && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="red" paddingX={2} paddingY={1}>
              <Text bold color="red">Delete account — this cannot be undone</Text>
              <Box marginTop={1} flexDirection="column">
                <Text><Text color="cyan">{selectedAcct.nickname ?? selectedAcct.name}</Text>  {selectedAcct.mask ? `···${selectedAcct.mask}` : ''}</Text>
                {selectedAcct.id.startsWith('manual-')
                  ? <Text dimColor>Removes this asset and its balance history.</Text>
                  : <Text dimColor>Removes this account, all its transactions, and balance history.</Text>
                }
              </Box>
              <Box marginTop={1} gap={4}>
                <Text color="red">[y] Yes, delete</Text>
                <Text color="green">[n] / Esc cancel</Text>
              </Box>
            </Box>
          )}

          {/* Nickname panel */}
          {acctMode === 'nickname' && selectedAcct && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
              <Text bold>Nickname: {selectedAcct.name}</Text>
              <Text dimColor>Leave empty to clear nickname</Text>
              <Box marginTop={1}>
                <Text>Nickname: </Text>
                <Text color="yellow">{nicknameInput}</Text>
                <Text color="cyan">▊</Text>
              </Box>
              <Box marginTop={1}><Text dimColor>Enter save · Esc cancel</Text></Box>
            </Box>
          )}

          {/* Update-value panel */}
          {acctMode === 'update-value' && selectedAcct && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
              <Text bold>Update value: {selectedAcct.name}</Text>
              <Box marginTop={1}>
                <Text>New value: $</Text>
                <Text color="yellow">{updateValueInput}</Text>
                <Text color="cyan">█</Text>
              </Box>
              {updateValueError && <Text color="red">{updateValueError}</Text>}
              <Box marginTop={1}><Text dimColor>Enter save · Esc cancel</Text></Box>
            </Box>
          )}

          {/* Edit panel */}
          {acctMode === 'edit' && selectedAcct && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
              <Text bold>Edit: {selectedAcct.name}{selectedAcct.mask ? ` ···${selectedAcct.mask}` : ''}</Text>
              <Box marginTop={1} flexDirection="column" gap={1}>
                <Box gap={2}>
                  <Text color={editField === 'type' ? 'cyan' : 'white'}>
                    {editField === 'type' ? '▶ ' : '  '}Type
                  </Text>
                  <Text color={editField === 'type' ? 'cyan' : undefined}>
                    {'← '}{editType}{'  →'}
                  </Text>
                </Box>
                <Box gap={2}>
                  <Text color={editField === 'subtype' ? 'cyan' : 'white'}>
                    {editField === 'subtype' ? '▶ ' : '  '}Subtype
                  </Text>
                  <Text color={editField === 'subtype' ? 'cyan' : 'yellow'}>
                    {'← '}{editSubtype || '—'}{'  →'}
                  </Text>
                </Box>
              </Box>
            </Box>
          )}
        </>
      )}

      {/* ── Dupes view ────────────────────────────────────────────────── */}
      {mainView === 'dupes' && (
        <Box flexDirection="column" marginTop={1}>
          {dupes.length === 0 ? (
            <Text color="green">No duplicate candidates found.</Text>
          ) : (
            dupes.map((pair, i) => {
              const isSelected = i === dupeCursor;
              return (
                <Box key={pair.csvId} flexDirection="column" marginBottom={1}>
                  <Box gap={2}>
                    <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶' : ' '}</Text>
                    <Text dimColor>{truncate(pair.accountName, 20).padEnd(20)}</Text>
                    <Text color="yellow">CSV</Text>
                    <Text dimColor>{pair.csvDate}</Text>
                    <Text color={isSelected ? 'cyan' : undefined}>{truncate(pair.csvName, 30).padEnd(30)}</Text>
                    <Text color="red">${Math.abs(pair.csvAmount).toFixed(2)}</Text>
                  </Box>
                  <Box gap={2}>
                    <Text> </Text>
                    <Text dimColor>{''.padEnd(20)}</Text>
                    <Text color="green">PLI</Text>
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
                <Text color="cyan">[l] Link a bank account  <Text dimColor>Opens Plaid in your browser</Text></Text>
                <Text color="cyan">[c] Import CSV file      <Text dimColor>Upload a statement export</Text></Text>
                <Text color="cyan">[m] Manual asset         <Text dimColor>House, car, or other asset</Text></Text>
                <Text color={syncStatus === 'syncing' ? 'yellow' : 'cyan'}>
                  [s] Force sync          <Text dimColor>Re-sync from Plaid now</Text>
                </Text>
              </Box>
              {syncMsg && <Box marginTop={1}><Text color={syncStatus === 'syncing' ? 'yellow' : 'green'}>{syncMsg}</Text></Box>}
              <Box marginTop={1}><Text dimColor>Tab or Esc to go back</Text></Box>
            </Box>
          )}

          {addStep === 'link-plaid' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Link Bank Account</Text>
              <Text color={linkStatus === 'done' ? 'green' : linkStatus === 'error' ? 'red' : 'yellow'}>
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
              <Box>
                <Text>Path: </Text>
                <Text color="yellow">{filePath}<Text color="cyan">█</Text></Text>
              </Box>
              {fileError && <Text color="red">{fileError}</Text>}
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
                    <Box key={i} gap={2}>
                      <Text color={i === colCursor ? 'cyan' : 'white'} dimColor={i !== colCursor}>
                        {i === colCursor ? '▶ ' : '  '}
                        {h.padEnd(24)}
                        <Text dimColor>  {truncate(sample, 36)}</Text>
                      </Text>
                    </Box>
                  );
                })}
              </Box>
              <Box marginTop={1} gap={3}>
                {dateCol !== null   && <Text dimColor>date: <Text color="green">{headers[dateCol]}</Text></Text>}
                {nameCol !== null   && <Text dimColor>name: <Text color="green">{headers[nameCol]}</Text></Text>}
                {amountCol !== null && <Text dimColor>amount: <Text color="green">{headers[amountCol]}</Text></Text>}
                {debitCol !== null  && <Text dimColor>debit: <Text color="green">{headers[debitCol]}</Text></Text>}
                {creditCol !== null && <Text dimColor>credit: <Text color="green">{headers[creditCol]}</Text></Text>}
              </Box>
            </Box>
          )}

          {addStep === 'map-amount-mode' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>How is the amount structured?</Text>
              <Text color="cyan">[s] Single column  <Text dimColor>(one column, positive or negative)</Text></Text>
              <Text color="cyan">[d] Debit / Credit  <Text dimColor>(two separate columns)</Text></Text>
            </Box>
          )}

          {addStep === 'direction' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>In column <Text color="yellow">"{headers[amountCol!]}"</Text>, does a positive number mean...</Text>
              <Text color="cyan">[i] Inflow  <Text dimColor>(money coming in)</Text></Text>
              <Text color="cyan">[o] Outflow <Text dimColor>(money going out)</Text></Text>
            </Box>
          )}

          {addStep === 'account' && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Which account do these transactions belong to?</Text>
              <Text dimColor>↑↓ select · Enter confirm</Text>
              <Box flexDirection="column" marginTop={1}>
                {csvAccounts.map((acct, i) => (
                  <Box key={acct.id} gap={2}>
                    <Text color={i === csvAccountCursor ? 'cyan' : 'white'} dimColor={i !== csvAccountCursor}>
                      {i === csvAccountCursor ? '▶ ' : '  '}{acct.name}
                      <Text dimColor>  {acct.mask ? `···${acct.mask}` : ''}</Text>
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {addStep === 'confirm' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Ready to import</Text>
              <Text>File: <Text color="yellow">{filePath}</Text></Text>
              <Text>Account: <Text color="cyan">{csvAccounts[csvAccountCursor]?.name}</Text></Text>
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
                      <Text color="yellow">{amount}</Text>
                    </Box>
                  );
                })}
              </Box>
              <Box marginTop={1} gap={4}>
                <Text color="cyan">[y] Import</Text>
                <Text color="red">[n] Cancel</Text>
              </Box>
            </Box>
          )}

          {addStep === 'done' && importResult && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold color="green">Import complete</Text>
              <Text>Imported: <Text color="green">{importResult.imported}</Text></Text>
              <Text dimColor>Skipped (duplicates/invalid): {importResult.skipped}</Text>
              <Box marginTop={1}><Text dimColor>Press Enter to return</Text></Box>
            </Box>
          )}

          {addStep === 'manual-name' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Manual Asset — Name</Text>
              <Text dimColor>Type a name for this asset (e.g. "House", "Car")</Text>
              <Box marginTop={1}>
                <Text>Name: </Text>
                <Text color="yellow">{manualName}</Text>
                <Text color="cyan">█</Text>
              </Box>
              <Text dimColor>Enter to continue · Esc cancel</Text>
            </Box>
          )}

          {addStep === 'manual-value' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold>Manual Asset — Current Value</Text>
              <Text dimColor>Asset: <Text color="cyan">{manualName}</Text></Text>
              <Box marginTop={1}>
                <Text>Value: $</Text>
                <Text color="yellow">{manualValue}</Text>
                <Text color="cyan">█</Text>
              </Box>
              {manualValueError && <Text color="red">{manualValueError}</Text>}
              <Text dimColor>Enter to save · Esc back</Text>
            </Box>
          )}

          {addStep === 'manual-done' && (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold color="green">Asset added</Text>
              <Text><Text color="cyan">{manualName}</Text> added to your accounts.</Text>
              <Text dimColor>Update its value anytime from the Accounts tab with [v].</Text>
              <Box marginTop={1}><Text dimColor>Press Enter to return</Text></Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
