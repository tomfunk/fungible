import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStatus } from '../hooks/useStatus.js';
import type { Profile, HouseholdMember } from '../../../../core/profile.js';
import { KeyHints } from '../components/KeyHints.js';
import { useUiPrefs, type PaletteName } from '../hooks/useUiPrefs.js';
import styles from './Settings.module.css';

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

  useEffect(() => {
    void api.profile.loadProfile().then((p) => {
      setProfile(p ?? { self: { name: '', birthYear: 0 }, children: [] });
      setLoaded(true);
    });
  }, []);

  if (!loaded || !profile) return <p className="dim">Loading…</p>;

  const members: HouseholdMember[] = [profile.self, ...(profile.spouse ? [profile.spouse] : []), ...profile.children];
  const valid =
    profile.self.name.trim() !== '' &&
    members.every((m) => m.name.trim() !== '' && validYear(m.birthYear));

  async function save() {
    if (!profile || !valid) return;
    await api.profile.saveProfile({
      self: { name: profile.self.name.trim(), birthYear: profile.self.birthYear },
      ...(profile.spouse ? { spouse: { name: profile.spouse.name.trim(), birthYear: profile.spouse.birthYear } } : {}),
      children: profile.children.map((c) => ({ name: c.name.trim(), birthYear: c.birthYear })),
    });
    showStatus('Profile saved');
  }

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens" />
      <h1 className={styles.title}>Settings</h1>

      <AppearancePanel />

      <section className={styles.panel}>
        <h2>Household</h2>
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
            className={styles.addBtn}
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
          className={styles.addBtn}
          onClick={() => setProfile({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] })}
        >
          + Add child
        </button>

        <div className={styles.actions}>
          {!valid && <span className="dim">Every member needs a name and a valid birth year.</span>}
          <button className={styles.btnPrimary} onClick={() => void save()} disabled={!valid}>
            Save profile
          </button>
        </div>
      </section>

      <ConfigPanel showStatus={showStatus} />

      <BackupPanel />

      {statusEl}
    </div>
  );
}

const PALETTE_OPTIONS: { value: PaletteName; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'high-contrast', label: 'High contrast' },
  { value: 'deuteranopia', label: 'Deuteranopia' },
  { value: 'protanopia', label: 'Protanopia' },
  { value: 'monochrome', label: 'Monochrome' },
];

function AppearancePanel() {
  const { palette, setPalette } = useUiPrefs();

  return (
    <section className={styles.panel}>
      <h2>Appearance</h2>
      <p className="dim">Color palette for charts and status colors. Applies immediately.</p>

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
    <section className={styles.panel}>
      <h2>Configuration</h2>
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
          className={styles.btnPrimary}
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
    <section className={styles.panel}>
      <h2>Backup</h2>
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
            checked={includeKey}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>{includeKey ? 'On' : 'Off'}</span>
        </label>
      </div>
    </section>
  );
}
