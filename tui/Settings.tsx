import { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { loadProfile, saveProfile, type Profile } from '../core/profile.js';
import { getSetting, setSetting, BACKUP_INCLUDE_KEY_KEY } from '../core/settings.js';
import { isAuthConfigured, sessionEmail } from '../core/auth-client.js';
import { runSyncCycle, startBackgroundSync, stopBackgroundSync, getSyncInfo } from '../core/sync-client.js';
import { getSyncMode, connectAccount, disconnectAccount, SyncError, type SyncMode } from '../core/sync-mode.js';
import { MigrateError } from '../core/migrate.js';
import { C_ACCENT, C_NEUTRAL, CURSOR, THEME_KEY, THEME_NAMES, type ThemeName } from './ui.js';
import { PageHeader, SectionHeader, SelectableRow } from './components/index.js';
import { Divider } from './fmt.js';
import { useSetTyping } from './TypingContext.js';

const LABEL_W = 16;
const VALUE_W = 18;

const DEFAULT_THEME: ThemeName = 'default';

function themeLabel(name: ThemeName): string {
  return name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

type FieldRow = { kind: 'field'; id: string; label: string; value: string; numeric?: boolean; mask?: boolean };
type ActionRow = { kind: 'action'; id: string; label: string };
type ThemeRow = { kind: 'theme'; id: 'theme'; label: string; value: ThemeName };
type ToggleRow = { kind: 'toggle'; id: 'backup-include-key'; label: string; value: boolean };
type SettingsRow = FieldRow | ActionRow | ThemeRow | ToggleRow;

// 'disabled' = FUNGIBLE_SYNC_URL unset (no sync UI at all); otherwise the install's mode.
type SyncUiState = {
  status: 'disabled' | SyncMode;
  email: string;
  password: string;
  busy: boolean;
  /** Set when connect hit account_mismatch: waiting for the user to confirm a reset. */
  mismatch: { createAccount: boolean } | null;
};

function buildSyncRows(sync: SyncUiState): SettingsRow[] {
  if (sync.status === 'disabled') return [];
  if (sync.mismatch) {
    return [
      { kind: 'action', id: 'sync-reset', label: sync.busy ? 'Connecting…' : '[Enter] Reset local sync state for this account and connect' },
      { kind: 'action', id: 'sync-cancel', label: '[Enter] Cancel' },
    ];
  }
  if (sync.status === 'byok') {
    return [
      { kind: 'field', id: 'sync-email', label: 'Email', value: sync.email },
      { kind: 'field', id: 'sync-password', label: 'Password', value: sync.password, mask: true },
      { kind: 'action', id: 'sync-login', label: sync.busy ? 'Connecting…' : '[Enter] Connect (log in)' },
      { kind: 'action', id: 'sync-register', label: '[Enter] Connect with a new account' },
    ];
  }
  return [
    { kind: 'action', id: 'sync-now', label: sync.busy ? 'Syncing…' : '[Enter] Sync now' },
    { kind: 'action', id: 'sync-logout', label: '[Enter] Disconnect (data stays local)' },
  ];
}

function buildRows(profile: Profile, theme: ThemeName, backupIncludeKey: boolean): SettingsRow[] {
  const r: SettingsRow[] = [
    { kind: 'field', id: 'self-name', label: 'Your name', value: profile.self.name },
    { kind: 'field', id: 'self-year', label: 'Birth year', value: profile.self.birthYear > 0 ? String(profile.self.birthYear) : '', numeric: true },
  ];
  if (profile.spouse) {
    r.push(
      { kind: 'field', id: 'spouse-name', label: 'Spouse name', value: profile.spouse.name },
      { kind: 'field', id: 'spouse-year', label: 'Spouse year', value: profile.spouse.birthYear > 0 ? String(profile.spouse.birthYear) : '', numeric: true },
    );
  } else {
    r.push({ kind: 'action', id: 'add-spouse', label: '[a] Add spouse' });
  }
  for (let i = 0; i < profile.children.length; i++) {
    const child = profile.children[i];
    r.push(
      { kind: 'field', id: `child-${i}-name`, label: `Child ${i + 1}`, value: child.name },
      { kind: 'field', id: `child-${i}-year`, label: `  birth year`, value: child.birthYear > 0 ? String(child.birthYear) : '', numeric: true },
    );
  }
  r.push({ kind: 'action', id: 'add-child', label: '[a] Add child' });
  r.push({ kind: 'theme', id: 'theme', label: 'Theme', value: theme });
  r.push({ kind: 'toggle', id: 'backup-include-key', label: 'Include key', value: backupIncludeKey });
  return r;
}

export function Settings({ onNavigate, isActive, showHints }: {
  onNavigate: (s: Screen) => void;
  isActive?: boolean;
  showHints: boolean;
}) {
  const setTyping = useSetTyping();
  const [profile, setProfile] = useState<Profile>({ self: { name: '', birthYear: 0 }, children: [] });
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);
  const [backupIncludeKey, setBackupIncludeKey] = useState(false);
  const [cursor, setCursor] = useState(0);

  const [sync, setSync] = useState<SyncUiState>({
    status: isAuthConfigured() ? 'byok' : 'disabled',
    email: '',
    password: '',
    busy: false,
    mismatch: null,
  });
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [heldCount, setHeldCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [superseded, setSuperseded] = useState<number | null>(null);
  const [clockSkew, setClockSkew] = useState(false);
  const [syncAccount, setSyncAccount] = useState<string | null>(null);

  useEffect(() => {
    void loadProfile().then((p) => { if (p) setProfile(p); });
    void getSetting(THEME_KEY).then((v) => {
      if (v && (THEME_NAMES as string[]).includes(v)) setTheme(v as ThemeName);
    });
    void getSetting(BACKUP_INCLUDE_KEY_KEY).then((v) => setBackupIncludeKey(v === 'true'));
    if (isAuthConfigured()) {
      void getSyncMode().then((mode) => setSync((s) => ({ ...s, status: mode })));
      void getSyncInfo().then((info) => {
        setPendingCount(info.pendingCount);
        setHeldCount(info.heldCount);
        setRejectedCount(info.rejectedCount);
        setLastSyncAt(info.lastSyncAt);
        setSyncAccount(sessionEmail() ?? info.userId);
      }).catch(() => {});
    }
  }, []);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  useEffect(() => { setTyping(editing); }, [editing, setTyping]);

  const rows = useMemo(
    () => [...buildRows(profile, theme, backupIncludeKey), ...buildSyncRows(sync)],
    [profile, theme, backupIncludeKey, sync],
  );
  // Put the cursor on the confirmation action when the mismatch prompt appears.
  const mismatchActive = sync.mismatch != null;
  useEffect(() => {
    if (!mismatchActive) return;
    const i = rows.findIndex((r) => r.id === 'sync-reset');
    if (i >= 0) setCursor(i);
  }, [mismatchActive]); // eslint-disable-line react-hooks/exhaustive-deps
  const clampedCursor = Math.min(cursor, rows.length - 1);
  const currentRow = rows[clampedCursor] as SettingsRow | undefined;

  function persist(next: Profile) {
    setProfile(next);
    void saveProfile(next);
  }

  async function refreshSyncInfo() {
    try {
      const info = await getSyncInfo();
      setPendingCount(info.pendingCount);
      setHeldCount(info.heldCount);
      setRejectedCount(info.rejectedCount);
      setLastSyncAt(info.lastSyncAt);
    } catch { /* ignore */ }
  }

  function describeSync(stats: Awaited<ReturnType<typeof runSyncCycle>>): string {
    const parts = [`${stats.pullApplied} pulled`, `${stats.pushed} pushed`];
    if (stats.superseded > 0) parts.push(`${stats.superseded} superseded by newer edits`);
    if (stats.errors.length > 0) parts.push(`${stats.errors.length} rejected`);
    return `Synced: ${parts.join(', ')}`;
  }

  async function doSyncCycle(prefix?: string) {
    const stats = await runSyncCycle();
    setSuperseded(stats.superseded);
    setClockSkew(stats.clockSkew === true);
    setSyncMsg(`${prefix ? prefix + ' ' : ''}${describeSync(stats)}`);
    await refreshSyncInfo();
  }

  async function doConnect(createAccount: boolean, resetForNewAccount = false) {
    if (sync.busy) return;
    setSyncMsg(null);
    setSync((s) => ({ ...s, busy: true }));
    try {
      await connectAccount(sync.email.trim(), sync.password, {
        createAccount,
        resetForNewAccount,
      });
      setSyncAccount(sessionEmail() ?? sync.email.trim());
      setSync((s) => ({ ...s, status: 'hosted', password: '', busy: false, mismatch: null }));
      startBackgroundSync();
      await doSyncCycle('Connected.');
    } catch (e) {
      if (e instanceof SyncError && e.code === 'account_mismatch') {
        setSync((s) => ({ ...s, busy: false, mismatch: { createAccount } }));
        setSyncMsg(
          'This device last synced as a different account. Reset the local sync state for this '
          + 'account to continue (your local data is kept and pushed to this account), or cancel.',
        );
        return;
      }
      setSync((s) => ({ ...s, busy: false }));
      if (e instanceof MigrateError && e.code === 'snapshot_failed') {
        setSyncMsg(`Error: Could not take a safety backup; sync was not enabled. ${e.message}`);
      } else {
        setSyncMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async function doSyncNow() {
    if (sync.busy) return;
    setSyncMsg(null);
    setSync((s) => ({ ...s, busy: true }));
    try {
      await doSyncCycle();
    } catch (e) {
      setSyncMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSync((s) => ({ ...s, busy: false }));
    }
  }

  async function doDisconnect() {
    if (sync.busy) return;
    stopBackgroundSync();
    try {
      await disconnectAccount();
      setSync((s) => ({ ...s, status: 'byok', email: '', password: '', mismatch: null }));
      setSyncMsg('Disconnected. Local data stays on this machine.');
      setSyncAccount(null);
      await refreshSyncInfo();
    } catch (e) {
      setSyncMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function cancelMismatch() {
    setSync((s) => ({ ...s, mismatch: null, password: '' }));
    setSyncMsg(null);
  }

  function commitEdit() {
    if (!currentRow || currentRow.kind !== 'field') return;
    const row = currentRow as FieldRow;
    const value = editBuffer.trim();

    if (row.id === 'sync-email') {
      setSync((s) => ({ ...s, email: value }));
      setEditing(false);
      setEditBuffer('');
      return;
    }
    if (row.id === 'sync-password') {
      setSync((s) => ({ ...s, password: editBuffer }));
      setEditing(false);
      setEditBuffer('');
      return;
    }

    const next: Profile = { ...profile, children: [...profile.children] };

    if (row.id === 'self-name') {
      next.self = { ...next.self, name: value };
    } else if (row.id === 'self-year') {
      const y = parseInt(value);
      if (value && !isNaN(y) && y >= 1900 && y <= new Date().getFullYear()) next.self = { ...next.self, birthYear: y };
    } else if (row.id === 'spouse-name' && next.spouse) {
      next.spouse = { ...next.spouse, name: value };
    } else if (row.id === 'spouse-year' && next.spouse) {
      const y = parseInt(value);
      if (value && !isNaN(y) && y >= 1900 && y <= new Date().getFullYear()) next.spouse = { ...next.spouse, birthYear: y };
    } else {
      const m = row.id.match(/^child-(\d+)-(name|year)$/);
      if (m) {
        const idx = parseInt(m[1]);
        const field = m[2];
        const child = { ...next.children[idx] };
        if (field === 'name') {
          child.name = value;
        } else {
          const y = parseInt(value);
          if (value && !isNaN(y) && y >= 1900 && y <= new Date().getFullYear()) child.birthYear = y;
        }
        next.children = [...next.children.slice(0, idx), child, ...next.children.slice(idx + 1)];
      }
    }
    persist(next);
    setEditing(false);
    setEditBuffer('');
  }

  function getChildIdx(id: string): number | null {
    const m = id.match(/^child-(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  function cycleTheme(delta: 1 | -1) {
    const i = THEME_NAMES.indexOf(theme);
    const next = THEME_NAMES[(i + delta + THEME_NAMES.length) % THEME_NAMES.length];
    setTheme(next);
    void setSetting(THEME_KEY, next);
  }

  function toggleBackupIncludeKey() {
    const next = !backupIncludeKey;
    setBackupIncludeKey(next);
    void setSetting(BACKUP_INCLUDE_KEY_KEY, next ? 'true' : 'false');
  }

  useInput((input, key) => {
    if (editing) {
      if (key.escape) { setEditing(false); setEditBuffer(''); return; }
      if (key.return) { commitEdit(); return; }
      if (key.backspace || key.delete) { setEditBuffer((b) => b.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) {
        if ((currentRow as FieldRow)?.numeric) {
          const maxLen = 4;
          if (/^\d$/.test(input) && editBuffer.length < maxLen) setEditBuffer((b) => b + input);
        } else {
          setEditBuffer((b) => b + input);
        }
      }
      return;
    }

    if (key.escape) { onNavigate('dashboard'); return; }
    if (handleNavKey(input, 'settings', onNavigate)) return;
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }

    if (currentRow?.kind === 'theme' && (key.leftArrow || key.rightArrow)) {
      cycleTheme(key.leftArrow ? -1 : 1);
      return;
    }

    if (currentRow?.kind === 'toggle' && (key.leftArrow || key.rightArrow)) {
      toggleBackupIncludeKey();
      return;
    }

    if (key.return) {
      if (!currentRow) return;
      if (currentRow.id === 'sync-login') { void doConnect(false); return; }
      if (currentRow.id === 'sync-register') { void doConnect(true); return; }
      if (currentRow.id === 'sync-reset') { void doConnect(sync.mismatch?.createAccount ?? false, true); return; }
      if (currentRow.id === 'sync-cancel') { cancelMismatch(); return; }
      if (currentRow.id === 'sync-now') { void doSyncNow(); return; }
      if (currentRow.id === 'sync-logout') { void doDisconnect(); return; }
      if (currentRow.kind === 'field') {
        setEditBuffer((currentRow as FieldRow).value);
        setEditing(true);
      } else if (currentRow.id === 'add-spouse') {
        persist({ ...profile, spouse: { name: '', birthYear: 0 } });
      } else if (currentRow.id === 'add-child') {
        persist({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] });
      }
      return;
    }

    if (input === 'a') {
      if (!profile.spouse) {
        persist({ ...profile, spouse: { name: '', birthYear: 0 } });
      } else {
        persist({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] });
      }
      return;
    }

    if (input === 'd' && currentRow) {
      if (currentRow.id === 'spouse-name' || currentRow.id === 'spouse-year') {
        const { spouse: _, ...rest } = profile;
        persist({ ...rest, children: [...profile.children] } as Profile);
        return;
      }
      const idx = getChildIdx(currentRow.id);
      if (idx !== null) {
        persist({ ...profile, children: profile.children.filter((_, i) => i !== idx) });
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
    }
  }, { isActive: isActive !== false });

  function renderField(row: SettingsRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    const isEditingThis = isSelected && editing;
    const field = row as FieldRow;
    const raw = isEditingThis ? editBuffer : field.value;
    const displayValue = field.mask ? '•'.repeat(raw.length) : raw;
    const hint = isEditingThis
      ? 'Enter confirm  ·  Esc cancel'
      : isSelected
        ? field.id.includes('spouse') ? 'Enter to edit  ·  [d] remove spouse'
          : field.id.includes('child') ? `Enter to edit  ·  [d] remove`
          : 'Enter to edit'
        : '';
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined}>{field.label.padEnd(LABEL_W)}</Text>
        <Box>
          <Text color={isSelected ? C_ACCENT : C_NEUTRAL}>{displayValue.padStart(VALUE_W)}</Text>
          {isEditingThis && <Text color={C_ACCENT}>{CURSOR}</Text>}
        </Box>
        <Text dimColor>{hint}</Text>
      </SelectableRow>
    );
  }

  function renderAction(row: SettingsRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>{(row as ActionRow).label}</Text>
      </SelectableRow>
    );
  }

  function renderTheme(row: ThemeRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(LABEL_W)}</Text>
        <Text color={isSelected ? C_ACCENT : C_NEUTRAL}>{themeLabel(row.value).padStart(VALUE_W)}</Text>
        <Text dimColor>{isSelected ? '←→ change  ·  restart to apply' : ''}</Text>
      </SelectableRow>
    );
  }

  function renderToggle(row: ToggleRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined}>{row.label.padEnd(LABEL_W)}</Text>
        <Text color={isSelected ? C_ACCENT : C_NEUTRAL}>{(row.value ? 'On' : 'Off').padStart(VALUE_W)}</Text>
        <Text dimColor>{isSelected ? '←→ toggle' : ''}</Text>
      </SelectableRow>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="settings" showHints={showHints} />
      <Box marginTop={1}><Text bold>Settings</Text></Box>
      {showHints && <Text dimColor>↑↓ navigate  ·  Enter edit  ·  [a] add  ·  [d] remove  ·  ←→ change theme/toggle  ·  Esc back</Text>}
      <Divider />

      {/* Household section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>HOUSEHOLD</SectionHeader>
        {rows[0] && renderField(rows[0], 0)}
        {rows[1] && renderField(rows[1], 1)}
      </Box>

      {/* Spouse section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>SPOUSE</SectionHeader>
        {profile.spouse
          ? (
            <>
              {rows[2] && rows[2].id === 'spouse-name' && renderField(rows[2], 2)}
              {rows[3] && rows[3].id === 'spouse-year' && renderField(rows[3], 3)}
            </>
          ) : (
            rows[2] && rows[2].id === 'add-spouse' && renderAction(rows[2], 2)
          )
        }
      </Box>

      {/* Children section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>CHILDREN</SectionHeader>
        {profile.children.length === 0 && <Box marginTop={1}><Text dimColor>No children added.</Text></Box>}
        {rows.map((row, i) => {
          if (row.id === 'add-child') return renderAction(row, i);
          if (/^child-\d+-(name|year)$/.test(row.id)) return renderField(row, i);
          return null;
        })}
      </Box>

      {/* Appearance section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>APPEARANCE</SectionHeader>
        {rows.map((row, i) => row.kind === 'theme' ? renderTheme(row, i) : null)}
      </Box>

      {/* Backup section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>BACKUP</SectionHeader>
        {rows.map((row, i) => row.kind === 'toggle' ? renderToggle(row, i) : null)}
        <Box marginTop={1}>
          <Text dimColor>
            Your ~/.fungible/key file decrypts linked bank connections. Off by default so backups
            don&apos;t bundle the key with the data it protects — turn on to include it in daily backups.
          </Text>
        </Box>
      </Box>

      {/* Sync section: only when FUNGIBLE_SYNC_URL is set, so BYOK-only installs see nothing new */}
      {sync.status !== 'disabled' && (
        <Box flexDirection="column" marginTop={1}>
          <SectionHeader>SYNC</SectionHeader>
          <Box marginTop={1} flexDirection="column">
            <Text>
              {sync.status === 'hosted'
                ? `Synced via account: ${syncAccount ?? '(unknown)'}`
                : 'Local (BYOK)'}
            </Text>
            {sync.status === 'hosted' && (
              <Text dimColor>
                {lastSyncAt ? `Last sync ${lastSyncAt.slice(0, 16).replace('T', ' ')}` : 'Not synced yet'}
                {`  ·  ${pendingCount ?? 0} pending`}
                {rejectedCount > 0 ? `  ·  ${rejectedCount} rejected` : ''}
                {superseded != null && superseded > 0 ? `  ·  ${superseded} superseded` : ''}
              </Text>
            )}
            {sync.status === 'hosted' && heldCount > 0 && (
              <Text dimColor>{`${heldCount} waiting for the server to catch up`}</Text>
            )}
            {sync.status === 'hosted' && clockSkew && (
              <Text color="yellow">This device's clock looks wrong; some changes were not accepted. Check the system date and time.</Text>
            )}
            {sync.status === 'byok' && !sync.mismatch && (
              <Text dimColor>Connect an account to sync across devices. Your data stays local if you disconnect.</Text>
            )}
            <Text dimColor>Syncing sends your data to your account on the server.</Text>
          </Box>
          {rows.map((row, i) => {
            if (row.kind === 'field' && row.id.startsWith('sync-')) return renderField(row, i);
            if (row.kind === 'action' && row.id.startsWith('sync-')) return renderAction(row, i);
            return null;
          })}
          {syncMsg && <Box marginTop={1}><Text color={syncMsg.startsWith('Error') ? 'red' : C_NEUTRAL}>{syncMsg}</Text></Box>}
        </Box>
      )}

    </Box>
  );
}
