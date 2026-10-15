import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStatus } from '../hooks/useStatus.js';
import type { Profile, HouseholdMember } from '../../../../core/profile.js';
import { KeyHints } from '../components/KeyHints.js';
import { useUiPrefs, type PaletteName, type RowDensity, type Theme } from '../hooks/useUiPrefs.js';
import { useQuery } from '../hooks/useQuery.js';
import {
  cycleNotes, describeCycle, SYNC_DISCLOSURE, type AccountState, type CycleSummary,
} from '../../../shared/account-types.js';
import styles from './Settings.module.css';

/** True in the browser build, where .env keys and key backups are not local concepts. */
function isWeb(): boolean {
  return (window as unknown as { __bridge?: { platform?: string } }).__bridge?.platform === 'web';
}

const MIN_YEAR = 1900;

function validYear(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= new Date().getFullYear();
}

function MemberRow({
  label,
  member,
  onChange,
  onRemove,
}: {
  label: string;
  member: HouseholdMember;
  onChange: (m: HouseholdMember) => void;
  onRemove?: () => void;
}) {
  const yearOk = member.birthYear === 0 || validYear(member.birthYear);
  return (
    <div className={styles.memberRow}>
      <span className={styles.memberLabel}>{label}</span>
      <input
        value={member.name}
        placeholder="Name"
        onChange={(e) => onChange({ ...member, name: e.target.value })}
      />
      <input
        className={`${styles.yearInput} ${yearOk ? '' : styles.yearBad}`}
        value={member.birthYear || ''}
        placeholder="Birth year"
        inputMode="numeric"
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
          onChange({ ...member, birthYear: digits ? parseInt(digits, 10) : 0 });
        }}
      />
      {onRemove ? (
        <button className={styles.removeBtn} onClick={onRemove}>
          remove
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

export function Settings() {
  const { showStatus, statusEl } = useStatus();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoadError(null);
    api.profile
      .loadProfile()
      .then((p) => {
        setProfile(p ?? { self: { name: '', birthYear: 0 }, children: [] });
        setLoaded(true);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [attempt]);

  if (loadError !== null) {
    return (
      <div className={styles.screen}>
        <p className="dim">Couldn't load your profile: {loadError}</p>
        <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }
  if (!loaded || !profile) return <p className="dim">Loading…</p>;

  const members: HouseholdMember[] = [profile.self, ...(profile.spouse ? [profile.spouse] : []), ...profile.children];
  const valid =
    profile.self.name.trim() !== '' &&
    members.every((m) => m.name.trim() !== '' && validYear(m.birthYear));

  async function save() {
    if (!profile || !valid) return;
    try {
      await api.profile.saveProfile({
        self: { name: profile.self.name.trim(), birthYear: profile.self.birthYear },
        ...(profile.spouse ? { spouse: { name: profile.spouse.name.trim(), birthYear: profile.spouse.birthYear } } : {}),
        children: profile.children.map((c) => ({ name: c.name.trim(), birthYear: c.birthYear })),
      });
      showStatus('Profile saved');
    } catch (e) {
      showStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 4000);
    }
  }

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens" />
      <h1 className={styles.title}>Settings</h1>

      <AccountPanel />

      <AppearancePanel />

      <section className={styles.section}>
        <h2 className={`sectionLabel ${styles.sectionTitle}`}>Household</h2>
        <p className="dim">
          Used for age-aware planning (retirement timelines, college horizons) and account-owner assignment.
        </p>

        <MemberRow label="You" member={profile.self} onChange={(m) => setProfile({ ...profile, self: m })} />

        {profile.spouse ? (
          <MemberRow
            label="Spouse"
            member={profile.spouse}
            onChange={(m) => setProfile({ ...profile, spouse: m })}
            onRemove={() => {
              const { spouse: _removed, ...rest } = profile;
              setProfile(rest);
            }}
          />
        ) : (
          <button
            className={`ghostBtn ${styles.addBtn}`}
            onClick={() => setProfile({ ...profile, spouse: { name: '', birthYear: 0 } })}
          >
            + Add spouse / partner
          </button>
        )}

        {profile.children.map((child, i) => (
          <MemberRow
            key={i}
            label={`Child ${i + 1}`}
            member={child}
            onChange={(m) => setProfile({ ...profile, children: profile.children.map((c, j) => (j === i ? m : c)) })}
            onRemove={() => setProfile({ ...profile, children: profile.children.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          className={`ghostBtn ${styles.addBtn}`}
          onClick={() => setProfile({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] })}
        >
          + Add child
        </button>

        <div className={styles.actions}>
          {!valid && <span className="dim">Every member needs a name and a valid birth year.</span>}
          <button className="btnPrimary" onClick={() => void save()} disabled={!valid}>
            Save profile
          </button>
        </div>
      </section>

      {!isWeb() && <ConfigPanel showStatus={showStatus} />}

      {!isWeb() && <BackupPanel />}

      {statusEl}
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

const ERASE_WORD = 'erase';

// Three shapes, one panel:
//   desktop without FUNGIBLE_SYNC_URL (state null): nothing at all, the plain BYOK app
//   not connected (desktop local, or a web browser that has not signed in): connect form
//   connected: counts, Sync now, and a way out (desktop: Disconnect; web: Sign out,
//   plus a separate, typed-confirmation "Sign out and erase this device")
function AccountPanel() {
  const web = isWeb();
  const [reload, setReload] = useState(0);
  const state: AccountState | null | undefined = useQuery(() => api.account.getSyncState(), [reload]);
  const [last, setLast] = useState<CycleSummary | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<{ createAccount: boolean } | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseWord, setEraseWord] = useState('');

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  async function connect(createAccount: boolean, resetForNewAccount = false) {
    await run(async () => {
      const r = await api.account.connect(email.trim(), password, { createAccount, resetForNewAccount });
      if (r.status === 'account_mismatch') {
        setMismatch({ createAccount });
        setMsg(
          web
            ? 'This browser holds data from a different account. Erase it to start clean, or keep it and add it to this account.'
            : 'This device last synced as a different account. Reset its local sync state to continue '
              + '(your local data is kept and pushed to this account), or cancel.',
        );
        return;
      }
      if (r.status === 'snapshot_failed') {
        setMsg(`Error: ${r.message}`);
        return;
      }
      setMismatch(null);
      setPassword('');
      setLast(r.summary);
      setMsg(`Connected. ${describeCycle(r.summary)}`);
    });
  }

  if (!state) return null;

  const connected = state.mode === 'hosted';
  const notes = last ? cycleNotes(last) : [];
  return (
    <section className={styles.section} aria-label="Account">
      <h2 className={`sectionLabel ${styles.sectionTitle}`}>Account</h2>

      <div className={styles.configRow}>
        <label className={styles.configLabel}>Mode</label>
        <span>
          {connected
            ? state.signedIn
              ? `Synced via account: ${state.email ?? 'signed in'}`
              : 'Sync paused: signed out'
            : 'Local only'}
        </span>
      </div>

      {state.persistent === false && (
        <p className="dim" role="status">
          This browser is not keeping your data between visits.
        </p>
      )}

      {connected && (
        <>
          <div className={styles.configRow}>
            <label className={styles.configLabel}>Last sync</label>
            <span>{formatWhen(state.lastSyncAt)}</span>
          </div>
          <div className={styles.configRow}>
            <label className={styles.configLabel}>Pending changes</label>
            <span>{state.pendingCount}</span>
          </div>
          {state.heldCount > 0 && (
            <div className={styles.configRow}>
              <label className={styles.configLabel}>Waiting on other data</label>
              <span>{state.heldCount}</span>
            </div>
          )}
          {state.rejectedCount > 0 && (
            <div className={styles.configRow}>
              <label className={styles.configLabel}>Rejected by server</label>
              <span>{state.rejectedCount}</span>
            </div>
          )}
        </>
      )}

      {connected && state.signedIn ? (
        <>
          <div className={styles.actions}>
            <button
              className="btnPrimary"
              disabled={busy}
              onClick={() => void run(async () => {
                const s = await api.account.syncNow();
                setLast(s);
                setMsg(describeCycle(s));
              })}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="ghostBtn"
              disabled={busy}
              onClick={() => void run(async () => {
                await api.account.disconnect();
                setLast(null);
                setMsg(web
                  ? 'Signed out. Your data stays in this browser.'
                  : 'Disconnected. Local data stays on this machine.');
              })}
            >
              {web ? 'Sign out (data stays in this browser)' : 'Disconnect (data stays local)'}
            </button>
          </div>
          {web && (
            <div className={styles.configRow}>
              {!eraseOpen ? (
                <button className="ghostBtn" disabled={busy} onClick={() => setEraseOpen(true)}>
                  Sign out and erase this device…
                </button>
              ) : (
                <div>
                  <p className="dim">
                    This signs you out and deletes this browser&rsquo;s copy of your data. It only goes ahead
                    when everything is synced. Type <strong>{ERASE_WORD}</strong> to confirm.
                  </p>
                  <input
                    aria-label="Type erase to confirm"
                    value={eraseWord}
                    onChange={(e) => setEraseWord(e.target.value)}
                    autoComplete="off"
                    disabled={busy}
                  />
                  <div className={styles.actions}>
                    <button
                      className="btnPrimary"
                      disabled={busy || eraseWord.trim().toLowerCase() !== ERASE_WORD}
                      onClick={() => void run(async () => {
                        const r = await api.account.signOutAndErase();
                        if (!r.erased) {
                          setMsg(`Nothing was erased. ${r.reason}`);
                          return;
                        }
                        window.location.reload();
                      })}
                    >
                      Sign out and erase
                    </button>
                    <button className="ghostBtn" disabled={busy} onClick={() => { setEraseOpen(false); setEraseWord(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : mismatch ? (
        <div className={styles.actions}>
          <button className="btnPrimary" disabled={busy} onClick={() => void connect(mismatch.createAccount, true)}>
            {web ? 'Keep this data and sign in' : 'Reset local sync state for this account and connect'}
          </button>
          {web && (
            <button
              className="ghostBtn"
              disabled={busy}
              onClick={() => void run(async () => { await api.account.eraseLocalData(); window.location.reload(); })}
            >
              Erase local data
            </button>
          )}
          <button className="ghostBtn" disabled={busy} onClick={() => { setMismatch(null); setMsg(null); setPassword(''); }}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <p className="dim">{SYNC_DISCLOSURE}</p>
          <div className={styles.configRow}>
            <label className={styles.configLabel} htmlFor="sync-email">Email</label>
            <input id="sync-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </div>
          <div className={styles.configRow}>
            <label className={styles.configLabel} htmlFor="sync-password">Password</label>
            <input id="sync-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </div>
          <div className={styles.actions}>
            <button
              className="btnPrimary"
              disabled={busy || !email.trim() || !password}
              onClick={() => void connect(false)}
            >
              {busy ? 'Connecting…' : 'Connect (log in)'}
            </button>
            <button className="ghostBtn" disabled={busy || !email.trim() || !password} onClick={() => void connect(true)}>
              Connect with a new account
            </button>
          </div>
        </>
      )}

      {notes.length > 0 && !msg && <p className="dim">{notes.join(' · ')}</p>}
      {msg && <p className="dim" role="status">{msg}</p>}
    </section>
  );
}

const PALETTE_OPTIONS: { value: PaletteName; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'high-contrast', label: 'High contrast' },
  { value: 'deuteranopia', label: 'Deuteranopia' },
  { value: 'protanopia', label: 'Protanopia' },
  { value: 'monochrome', label: 'Monochrome' },
];

// Compact listed first — it's the default now (see useUiPrefs.tsx's
// readDensity()), matching how the palette list above leads with its
// own default ('default').
const DENSITY_OPTIONS: { value: RowDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'balanced', label: 'Balanced' },
];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

function AppearancePanel() {
  const { theme, setTheme, keys, toggleKeys, palette, setPalette, density, setDensity } = useUiPrefs();

  return (
    <section className={styles.section}>
      <h2 className={`sectionLabel ${styles.sectionTitle}`}>Appearance</h2>
      <p className="dim">Color palette for charts and status colors. Applies immediately.</p>

      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Theme
          <span className={styles.configHint}>Dark or light mode</span>
        </label>
        <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          {THEME_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Keyboard shortcut hints
          <span className={styles.configHint}>TUI-style keybindings: 0-9 navigate, plus per-screen keys shown as hints</span>
        </label>
        <button
          type="button"
          className={keys ? `chip chipActive ${styles.toggleChip}` : `chip ${styles.toggleChip}`}
          role="switch"
          aria-checked={keys}
          aria-label="Keyboard shortcut hints"
          onClick={toggleKeys}
        >
          {keys ? 'On' : 'Off'}
        </button>
      </div>

      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Color palette
          <span className={styles.configHint}>Colorblind-friendly options — remaps red/green or drops hue entirely</span>
        </label>
        <select aria-label="Color palette" value={palette} onChange={(e) => setPalette(e.target.value as PaletteName)}>
          {PALETTE_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Row density
          <span className={styles.configHint}>Vertical padding for every table — Transactions, Net Worth, Rules, Accounts, Tags, Canvas</span>
        </label>
        <select aria-label="Row density" value={density} onChange={(e) => setDensity(e.target.value as RowDensity)}>
          {DENSITY_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

type ConfigField = {
  key: string;
  label: string;
  hint: string;
  secret?: boolean;
};

const CONFIG_FIELDS: ConfigField[] = [
  { key: 'PLAID_CLIENT_ID', label: 'Plaid Client ID', hint: 'Plaid dashboard → Team Settings → Keys' },
  { key: 'PLAID_SECRET', label: 'Plaid Secret', hint: 'Matches the selected Plaid environment', secret: true },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', hint: 'Enables the agent (Claude)', secret: true },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', hint: 'Alternate agent provider', secret: true },
];

const PLAID_ENVS = ['sandbox', 'production'] as const;

function ConfigPanel({ showStatus }: { showStatus: (msg: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [plaidEnv, setPlaidEnv] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const hasInput = Object.values(values).some((v) => v.trim() !== '') || plaidEnv !== '';

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, string> = { ...values };
      if (plaidEnv) payload['PLAID_ENV'] = plaidEnv;
      const { written } = await api.config.writeEnv(payload);
      setValues({});
      setPlaidEnv('');
      showStatus(
        written.length === 0
          ? 'Nothing to save'
          : `Saved ${written.length} value${written.length === 1 ? '' : 's'} · restart to apply`,
      );
    } catch (e) {
      showStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={`sectionLabel ${styles.sectionTitle}`}>Configuration</h2>
      <p className="dim">
        Write API keys and Plaid credentials to <span className="num">~/.fungible/.env</span>. Fields are blank by
        design — existing values aren't shown. Leave a field blank to keep its current value; fill in only what you
        want to change. Restart the app for changes to take effect.
      </p>

      {CONFIG_FIELDS.map((f) => (
        <div key={f.key} className={styles.configRow}>
          <label className={styles.configLabel}>
            {f.label}
            <span className={styles.configHint}>{f.hint}</span>
          </label>
          <input
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder="(unchanged)"
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </div>
      ))}

      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Plaid Environment
          <span className={styles.configHint}>"sandbox" for testing, "production" for real bank data</span>
        </label>
        <select value={plaidEnv} onChange={(e) => setPlaidEnv(e.target.value)}>
          <option value="">(unchanged)</option>
          {PLAID_ENVS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.actions}>
        <button
          className="btnPrimary"
          onClick={() => void save()}
          disabled={!hasInput || saving}
        >
          {saving ? 'Saving…' : 'Save to .env'}
        </button>
      </div>
    </section>
  );
}

function BackupPanel() {
  const [includeKey, setIncludeKey] = useState(false);

  useEffect(() => {
    void api.settings.getBackupIncludeKey().then((v) => setIncludeKey(v === 'true'));
  }, []);

  function toggle(checked: boolean) {
    setIncludeKey(checked);
    void api.settings.setBackupIncludeKey(checked ? 'true' : 'false');
  }

  return (
    <section className={styles.section}>
      <h2 className={`sectionLabel ${styles.sectionTitle}`}>Backup</h2>
      <div className={styles.configRow}>
        <label className={styles.configLabel}>
          Include encryption key
          <span className={styles.configHint}>
            Your encryption key protects your linked banks. Off by default — turning this on
            includes it in your daily backups.
          </span>
        </label>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            aria-label="Include encryption key"
            checked={includeKey}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>{includeKey ? 'On' : 'Off'}</span>
        </label>
      </div>
    </section>
  );
}
