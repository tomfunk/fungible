import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useStatus } from '../hooks/useStatus.js';
import { useSyncStatus } from '../hooks/useSyncStatus.js';
import { Modal } from '../components/Modal.js';
import type { LinkedAccount, CsvAccount } from '../../../../core/queries.js';
import { SUBTYPE_DISPLAY, ACCOUNT_TYPES, SUBTYPES, MONTHS } from '../constants.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { fmtTimeAgo, fmtSyncedAt } from '../../../../core/fmt.js';
import styles from './Accounts.module.css';

type Tab = 'accounts' | 'links' | 'add-data' | 'dupes';

const TAB_LABELS: Record<Tab, string> = {
  accounts: 'Accounts', links: 'Links', 'add-data': 'Add Data', dupes: 'Dupes',
};

function fmtDate(d: string | null): string {
  if (!d) return 'never';
  const dt = new Date(d + 'T12:00:00');
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

export function Accounts() {
  const { showStatus, statusEl } = useStatus();
  const [tab, setTab] = useState<Tab>('accounts');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const accounts = useQuery(() => api.queries.getLinkedAccounts(), [reloadKey]) ?? [];
  const dupes = useQuery(() => api.accounts.getCsvPlaidDupeCandidates(), [reloadKey]) ?? [];
  const members = useQuery(() => api.profile.getHouseholdMembers(), [reloadKey]) ?? [];
  const lastSynced = useQuery(() => api.sync.getLastSyncedAt(), [reloadKey]);
  // One row per Plaid connection — the Links tab manages items, not accounts.
  const items = useQuery(() => api.queries.getLinkedItems(), [reloadKey]) ?? [];

  const [editAcct, setEditAcct] = useState<LinkedAccount | null>(null);
  const [valueAcct, setValueAcct] = useState<LinkedAccount | null>(null);
  const [deleteAcct, setDeleteAcct] = useState<LinkedAccount | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const plaidConfigured = useQuery(() => api.plaid.isConfigured(), []) ?? false;
  // Item ids that failed the most recent sync (from either the startup or the
  // user-triggered path), pushed from main — used to badge account rows.
  const { failingItems } = useSyncStatus();

  async function forceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const results = await api.sync.syncAll(true);
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        // Row badges + global banner update from the sync-status push; here we
        // just surface a transient toast naming the account(s) and the reason.
        const desc = failed.map((r) => {
          const names = accounts.filter((a) => a.item_id === r.itemId).map((a) => a.nickname ?? a.name);
          return `${names.join(', ') || r.itemId}: ${r.error}`;
        }).join('  ·  ');
        showStatus(`Sync failed: ${desc}`, 8000);
      } else {
        const added = results.reduce((s, r) => s + r.added, 0);
        showStatus(`Sync done — ${added} new transaction${added === 1 ? '' : 's'}`, 4000);
      }
      reload();
    } catch {
      showStatus('Sync failed', 3000);
    } finally {
      setSyncing(false);
    }
  }

  const TABS: Tab[] = ['accounts', 'links', 'add-data', 'dupes'];
  useScreenKeys({
    Tab: () => setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length]),
    s: () => void forceSync(),
  });

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [tab] view   [s] sync" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Accounts</h1>
        <div className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? styles.tabActive : styles.tab} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
              {t === 'dupes' && dupes.length > 0 ? ` (${dupes.length})` : ''}
              {t === 'links' && failingItems.size > 0 ? <span className="neg"> ⚠</span> : ''}
            </button>
          ))}
        </div>
        <div className={styles.syncRow}>
          <button className={styles.syncBtn} onClick={() => void forceSync()} disabled={syncing}>
            {syncing ? 'Syncing…' : '⟳ Sync'}
          </button>
          {lastSynced !== undefined && (
            <span className="dim">{fmtTimeAgo(lastSynced ?? null)}</span>
          )}
        </div>
      </div>

      {tab === 'accounts' && (
        <section className={styles.panel}>
          {accounts.length === 0 ? (
            <p className="dim">No accounts yet — use Add Data to link a bank or import a CSV.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Mask</th>
                  <th className={styles.th}>Type</th>
                  <th className={styles.th}>Institution</th>
                  <th className={styles.th}>Synced</th>
                  <th className={styles.th}>Owner</th>
                  <th className={styles.th} />
                </tr>
              </thead>
              <tbody>
                {accounts.map((acct) => {
                  const raw = acct.subtype ?? acct.type;
                  // A freshly linked institution has no accounts row yet, so it has
                  // nothing to edit or delete and no mask/type to show.
                  const awaiting = acct.awaitingFirstSync;
                  return (
                    <tr key={acct.id} className={styles.row} onClick={awaiting ? undefined : () => setEditAcct(acct)}>
                      <td className={styles.tdName}>
                        {acct.nickname ?? acct.name}
                        {acct.nickname && <span className="manual" title={`Nickname for ${acct.name}`}> ✎</span>}
                        {acct.excluded && <span className="dim" title="Excluded from net worth"> ⊘ excl</span>}
                      </td>
                      <td className="num dim">{!awaiting && acct.mask ? `···${acct.mask}` : ''}</td>
                      <td className="dim">{awaiting ? '' : (SUBTYPE_DISPLAY[raw] ?? raw)}</td>
                      <td className="dim">{acct.institution_name ?? ''}</td>
                      <td>
                        {acct.item_id && failingItems.has(acct.item_id) ? (
                          <span className="neg">⚠ sync failed</span>
                        ) : awaiting ? (
                          <span className="warn">◷ awaiting first sync</span>
                        ) : acct.item_last_synced_at !== null ? (
                          <span className="dim">synced <span className="pos">{fmtSyncedAt(acct.item_last_synced_at)}</span></span>
                        ) : acct.last_synced ? (
                          <span className="dim">synced <span className="pos">{fmtDate(acct.last_synced)}</span></span>
                        ) : (
                          <span className="warn">not synced</span>
                        )}
                      </td>
                      <td className="manual">{acct.owner ?? ''}</td>
                      <td className={styles.tdActions}>
                        {!awaiting && acct.id.startsWith('manual-') && (
                          <button
                            className={styles.rowBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              setValueAcct(acct);
                            }}
                          >
                            value
                          </button>
                        )}
                        {!awaiting && (
                          <button
                            className={styles.rowBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditAcct(acct);
                            }}
                          >
                            edit
                          </button>
                        )}
                        {!awaiting && (
                          <button
                            className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteAcct(acct);
                            }}
                          >
                            delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'links' && (
        <section className={styles.panel}>
          {items.length === 0 ? (
            <p className="dim">No bank connections yet — use Add Data to link one.</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Institution</th>
                  <th className={styles.th}>Accounts</th>
                  <th className={styles.th}>History window</th>
                  <th className={styles.th}>Status</th>
                  <th className={styles.th} />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.item_id} className={styles.row}>
                    <td className={styles.tdName}>
                      {item.institution_name ?? '(unknown institution)'}
                      {!item.hasCursor && !item.awaitingFirstSync && (
                        <span className="dim" title="No sync cursor stored — the next sync replays this connection's full history"> · full replay pending</span>
                      )}
                    </td>
                    <td className="num dim">{item.account_count}</td>
                    {/* Locked at link time; Plaid rejects a wider window on an
                        item that already has Transactions. */}
                    <td className="dim" title="Fixed when the connection was created — only a new connection can change it">
                      {item.days_requested ? `${item.days_requested} days` : '90 days (default)'}
                    </td>
                    <td>
                      {failingItems.has(item.item_id) ? (
                        <span className="neg">⚠ sync failed</span>
                      ) : item.awaitingFirstSync ? (
                        <span className="warn">◷ awaiting first sync</span>
                      ) : item.last_synced_at !== null ? (
                        <span className="dim">synced <span className="pos">{fmtSyncedAt(item.last_synced_at)}</span></span>
                      ) : (
                        <span className="warn">never synced</span>
                      )}
                    </td>
                    <td className={styles.tdActions}>
                      <button
                        className={styles.rowBtn}
                        title="Reconnect this institution through Plaid"
                        onClick={() => setLinkOpen(true)}
                      >
                        repair
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'add-data' && (
        <div className={styles.addGrid}>
          {plaidConfigured ? (
            <button className={styles.addCard} onClick={() => setLinkOpen(true)}>
              <div className={styles.addTitle}>Link a bank</div>
              <div className="dim">Opens Plaid in your browser to connect an account</div>
            </button>
          ) : (
            <div className={`${styles.addCard} ${styles.addCardDisabled}`}>
              <div className={styles.addTitle}>Link a bank</div>
              <div className="dim">Plaid not configured — set PLAID_CLIENT_ID and PLAID_SECRET in ~/.fungible/.env</div>
            </div>
          )}
          <button className={styles.addCard} onClick={() => setCsvOpen(true)}>
            <div className={styles.addTitle}>Import CSV</div>
            <div className="dim">Upload a statement export and map its columns</div>
          </button>
          <button className={styles.addCard} onClick={() => setManualOpen(true)}>
            <div className={styles.addTitle}>Manual asset</div>
            <div className="dim">House, car, or other asset tracked by value</div>
          </button>
          <button className={styles.addCard} onClick={() => void forceSync()} disabled={syncing}>
            <div className={styles.addTitle}>{syncing ? 'Syncing…' : 'Force sync'}</div>
            <div className="dim">Re-sync all linked accounts from Plaid now</div>
          </button>
        </div>
      )}

      {tab === 'dupes' && (
        <section className={styles.panel}>
          {dupes.length === 0 ? (
            <p className="pos">No duplicate candidates found.</p>
          ) : (
            <>
              <div className={styles.dupeBar}>
                <span className="dim">{dupes.length} CSV transaction{dupes.length === 1 ? '' : 's'} that look like Plaid duplicates</span>
                <button
                  className={styles.rowBtnDangerSolid}
                  onClick={async () => {
                    await api.accounts.deleteAllDuplicates(dupes.map((p) => p.csvId));
                    showStatus(`Deleted ${dupes.length} duplicate${dupes.length === 1 ? '' : 's'}`, 2500);
                    reload();
                  }}
                >
                  Delete all CSV copies
                </button>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Account</th>
                    <th className={styles.th}>Source</th>
                    <th className={styles.th}>Date</th>
                    <th className={styles.th}>Description</th>
                    <th className={styles.th}>Amount</th>
                    <th className={styles.th} />
                  </tr>
                </thead>
                <tbody>
                  {dupes.map((pair) => (
                    <React.Fragment key={pair.csvId}>
                      <tr className={styles.dupeCsvRow}>
                        <td className="dim">{pair.accountName}</td>
                        <td className="warn">CSV</td>
                        <td className="num dim">{pair.csvDate}</td>
                        <td>{pair.csvName}</td>
                        <td className="num neg">${Math.abs(pair.csvAmount).toFixed(2)}</td>
                        <td className={styles.tdActions}>
                          <button
                            className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                            onClick={async () => {
                              await api.accounts.deleteDuplicate(pair.csvId);
                              showStatus('CSV copy deleted');
                              reload();
                            }}
                          >
                            delete CSV copy
                          </button>
                        </td>
                      </tr>
                      <tr className={styles.dupePlaidRow}>
                        <td />
                        <td className="pos">Plaid</td>
                        <td className="num dim">{pair.plaidDate}</td>
                        <td className="dim">{pair.plaidName}</td>
                        <td />
                        <td />
                      </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {editAcct && (
        <EditAccountModal
          acct={editAcct}
          members={members}
          onClose={() => setEditAcct(null)}
          onSaved={(name) => {
            setEditAcct(null);
            showStatus(`Updated ${name}`);
            reload();
          }}
        />
      )}

      {valueAcct && (
        <ValueModal
          acct={valueAcct}
          onClose={() => setValueAcct(null)}
          onSaved={() => {
            setValueAcct(null);
            showStatus(`Updated value for ${valueAcct.name}`);
            reload();
          }}
        />
      )}

      {deleteAcct && (
        <Modal title="Delete account — this cannot be undone" onClose={() => setDeleteAcct(null)} accent="var(--negative)">
          <p>
            <span className="accent">{deleteAcct.nickname ?? deleteAcct.name}</span>{' '}
            {deleteAcct.mask ? <span className="dim">···{deleteAcct.mask}</span> : null}
          </p>
          <p className="dim">
            {deleteAcct.id.startsWith('manual-')
              ? 'Removes this asset and its balance history.'
              : 'Removes this account, all its transactions, and balance history.'}
          </p>
          <div className={styles.modalActions}>
            <button className={styles.btnSecondary} onClick={() => setDeleteAcct(null)}>
              Cancel
            </button>
            <button
              className={styles.btnDanger}
              onClick={async () => {
                try {
                  await api.accounts.deleteAccount(deleteAcct.id);
                  showStatus(`Deleted ${deleteAcct.nickname ?? deleteAcct.name}`);
                } catch {
                  showStatus(`Failed to delete ${deleteAcct.nickname ?? deleteAcct.name}`, 3000);
                }
                setDeleteAcct(null);
                reload();
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}

      {manualOpen && (
        <ManualAssetModal
          onClose={() => setManualOpen(false)}
          onSaved={(name) => {
            setManualOpen(false);
            showStatus(`${name} added`);
            reload();
            setTab('accounts');
          }}
        />
      )}

      {csvOpen && (
        <CsvImportModal
          onClose={() => setCsvOpen(false)}
          onDone={(imported, skipped) => {
            setCsvOpen(false);
            showStatus(`Imported ${imported} · skipped ${skipped}`, 4000);
            reload();
            setTab('accounts');
          }}
        />
      )}

      {linkOpen && (
        <LinkBankModal
          onClose={() => setLinkOpen(false)}
          onLinked={(institution) => {
            setLinkOpen(false);
            showStatus(`Connected ${institution ?? 'bank'} — syncing…`, 4000);
            reload();
            setTab('accounts');
            void forceSync();
          }}
        />
      )}

      {statusEl}
    </div>
  );
}

// ── Plaid link modal ────────────────────────────────────────────────────────

function LinkBankModal({
  onClose,
  onLinked,
}: {
  onClose: () => void;
  onLinked: (institution: string | null) => void;
}) {
  const [days, setDays] = useState('');
  const [defaultDays, setDefaultDays] = useState(730);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.plaid.getDefaultDaysRequested().then((d) => {
      setDefaultDays(d);
      setDays(String(d));
    });
  }, []);

  async function start() {
    const n = parseInt(days, 10);
    if (isNaN(n) || n < 30 || n > 730) {
      setError('Enter a whole number from 30 to 730');
      return;
    }
    setError('');
    setRunning(true);
    try {
      const { institutionName } = await api.plaid.linkBank(n);
      onLinked(institutionName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Link failed');
      setRunning(false);
    }
  }

  return (
    <Modal title="Link a bank" onClose={onClose}>
      {running ? (
        <div>
          <p className="accent">⟳ Complete the Plaid flow in your browser, then return here.</p>
          <p className="dim">This window updates automatically once the bank is connected.</p>
          {error && <p className="neg">{error}</p>}
        </div>
      ) : (
        <>
          <div className={styles.formGrid}>
            <label>History (days)</label>
            <input
              value={days}
              onChange={(e) => {
                setDays(e.target.value.replace(/\D/g, '').slice(0, 3));
                setError('');
              }}
            />
          </div>
          <p className="dim">
            How many days of transactions Plaid backfills (30–730, default {defaultDays}). Locked in when the bank is
            linked.
          </p>
          {error && <p className="neg">{error}</p>}
          <div className={styles.modalActions}>
            <button className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button className={styles.btnPrimary} onClick={() => void start()}>
              Open Plaid in browser
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Edit account modal ──────────────────────────────────────────────────────

function EditAccountModal({
  acct,
  members,
  onClose,
  onSaved,
}: {
  acct: LinkedAccount;
  members: string[];
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const [nickname, setNickname] = useState(acct.nickname ?? '');
  const [owner, setOwner] = useState(acct.owner ?? '');
  const initialSubtypes = SUBTYPES[acct.type] ?? [];
  const [type, setType] = useState(acct.type);
  const [subtype, setSubtype] = useState(
    initialSubtypes.includes(acct.subtype ?? '') ? (acct.subtype ?? '') : (initialSubtypes[0] ?? ''),
  );
  const [apr, setApr] = useState(acct.apr !== null && acct.apr !== undefined ? String(acct.apr) : '');
  const [excluded, setExcluded] = useState(acct.excluded);

  const isDebt = type === 'credit' || type === 'loan';
  const subtypes = SUBTYPES[type] ?? [];

  async function save() {
    const aprVal = apr.trim() ? parseFloat(apr) : null;
    await api.accounts.updateAccountTypeSubtype(acct.id, type, subtype.trim() || null);
    await api.accounts.updateAccountNickname(acct.id, nickname.trim() || null);
    await api.accounts.updateAccountOwner(acct.id, owner.trim() || null);
    if (isDebt) await api.accounts.updateAccountApr(acct.id, aprVal !== null && !isNaN(aprVal) ? aprVal : null);
    await api.accounts.updateAccountExcluded(acct.id, excluded);
    onSaved(nickname.trim() || acct.name);
  }

  return (
    <Modal
      title={
        <>
          Edit <span className="dim">{acct.name}{acct.mask ? ` ···${acct.mask}` : ''}</span>
        </>
      }
      onClose={onClose}
    >
      <div className={styles.formGrid}>
        <label>Nickname</label>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="none" autoFocus />
        <label>Owner</label>
        {members.length > 0 ? (
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <span className="dim">Add household members in Settings</span>
        )}
        <label>Type</label>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setSubtype(SUBTYPES[e.target.value]?.[0] ?? '');
          }}
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label>Subtype</label>
        {subtypes.length > 0 ? (
          <select value={subtype} onChange={(e) => setSubtype(e.target.value)}>
            {subtypes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <span className="dim">—</span>
        )}
        {isDebt && (
          <>
            <label>APR %</label>
            <input value={apr} onChange={(e) => setApr(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.0" />
          </>
        )}
        <label>Net worth</label>
        <label className={styles.checkboxRow}>
          <input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} />
          <span>Exclude from net worth</span>
        </label>
      </div>
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── Manual value update ─────────────────────────────────────────────────────

function ValueModal({ acct, onClose, onSaved }: { acct: LinkedAccount; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function save() {
    const v = parseFloat(value.replace(/[$,]/g, ''));
    if (isNaN(v) || v < 0) {
      setError('Enter a valid positive number');
      return;
    }
    await api.accounts.updateAccountValue(acct.id, v);
    onSaved();
  }

  return (
    <Modal title={`Update value · ${acct.name}`} onClose={onClose} accent="var(--warning)">
      <div className={styles.formGrid}>
        <label>New value $</label>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          autoFocus
        />
      </div>
      {error && <p className="neg">{error}</p>}
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── Manual asset creation ───────────────────────────────────────────────────

function ManualAssetModal({ onClose, onSaved }: { onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function save() {
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    const v = parseFloat(value.replace(/[$,]/g, ''));
    if (isNaN(v) || v < 0) {
      setError('Enter a valid positive value');
      return;
    }
    await api.accounts.createManualAccount(name.trim(), v);
    onSaved(name.trim());
  }

  return (
    <Modal title="Manual asset" onClose={onClose}>
      <div className={styles.formGrid}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. "House", "Car"' autoFocus />
        <label>Value $</label>
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </div>
      {error && <p className="neg">{error}</p>}
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()}>
          Add asset
        </button>
      </div>
    </Modal>
  );
}

// ── CSV import wizard (single-form, unlike the TUI's step flow) ─────────────

type CsvData = { path: string; headers: string[]; rows: string[][] };

function CsvImportModal({ onClose, onDone }: { onClose: () => void; onDone: (imported: number, skipped: number) => void }) {
  const [csv, setCsv] = useState<CsvData | null>(null);
  const [dateCol, setDateCol] = useState<number>(-1);
  const [nameCol, setNameCol] = useState<number>(-1);
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [amountCol, setAmountCol] = useState<number>(-1);
  const [debitCol, setDebitCol] = useState<number>(-1);
  const [creditCol, setCreditCol] = useState<number>(-1);
  const [positiveIsInflow, setPositiveIsInflow] = useState(false);
  const [csvAccounts, setCsvAccounts] = useState<CsvAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [creatingAcct, setCreatingAcct] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('credit');
  const [newSubtype, setNewSubtype] = useState('credit card');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  async function pick() {
    const result = await api.files.pickCsv();
    if (!result) return;
    if (result.headers.length === 0) {
      setError('No columns found in that file');
      return;
    }
    setError('');
    setCsv(result);
    const h = result.headers.map((x) => x.toLowerCase());
    setDateCol(h.findIndex((x) => x.includes('date') || x.includes('posted')));
    setNameCol(h.findIndex((x) => x.includes('desc') || x.includes('name') || x.includes('merchant')));
    const accts = await api.queries.getCsvAccounts();
    setCsvAccounts(accts);
    if (accts.length > 0) setAccountId(accts[0].id);
  }

  useEffect(() => {
    void pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createAccount() {
    if (!newName.trim()) return;
    await api.accounts.createCsvAccount(newName.trim(), newType, newSubtype.trim() || null);
    const accts = await api.queries.getCsvAccounts();
    setCsvAccounts(accts);
    const created = accts.find((a) => a.name === newName.trim());
    if (created) setAccountId(created.id);
    setCreatingAcct(false);
    setNewName('');
  }

  const valid =
    !!csv &&
    dateCol >= 0 &&
    nameCol >= 0 &&
    accountId !== '' &&
    (amountMode === 'single' ? amountCol >= 0 : debitCol >= 0 && creditCol >= 0);

  function previewAmount(row: string[]): string {
    if (amountMode === 'single' && amountCol >= 0) {
      const raw = parseFloat(row[amountCol] || '0') || 0;
      const v = positiveIsInflow ? -raw : raw;
      return `$${Math.abs(v).toFixed(2)}`;
    }
    if (amountMode === 'split' && debitCol >= 0 && creditCol >= 0) {
      const d = parseFloat(row[debitCol] || '0') || 0;
      const c = parseFloat(row[creditCol] || '0') || 0;
      return `$${Math.abs(d > 0 ? d : c).toFixed(2)}`;
    }
    return '—';
  }

  async function doImport() {
    if (!csv || !valid || importing) return;
    const acct = csvAccounts.find((a) => a.id === accountId);
    if (!acct) return;
    setImporting(true);
    try {
      const result = await api.accounts.importCsvTransactions(csv.rows, acct, {
        amountMode,
        dateCol,
        nameCol,
        amountCol: amountMode === 'single' ? amountCol : null,
        debitCol: amountMode === 'split' ? debitCol : null,
        creditCol: amountMode === 'split' ? creditCol : null,
        positiveIsInflow,
      });
      onDone(result.imported, result.skipped);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      setImporting(false);
    }
  }

  function colSelect(value: number, set: (n: number) => void) {
    return (
      <select value={value} onChange={(e) => set(Number(e.target.value))}>
        <option value={-1}>— pick column —</option>
        {(csv?.headers ?? []).map((h, i) => (
          <option key={`${h}-${i}`} value={i}>
            {h}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Modal title="Import CSV" onClose={onClose}>
      {!csv ? (
        <div>
          <p className="dim">Choose a CSV file to import.</p>
          {error && <p className="neg">{error}</p>}
          <div className={styles.modalActions}>
            <button className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button className={styles.btnPrimary} onClick={() => void pick()}>
              Choose file…
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="dim">
            {csv.path.split('/').pop()} · {csv.rows.length} rows
          </p>
          <div className={styles.formGrid}>
            <label>Date column</label>
            {colSelect(dateCol, setDateCol)}
            <label>Description</label>
            {colSelect(nameCol, setNameCol)}
            <label>Amount</label>
            <div className={styles.inlineRow}>
              <select value={amountMode} onChange={(e) => setAmountMode(e.target.value as 'single' | 'split')}>
                <option value="single">single column</option>
                <option value="split">debit / credit columns</option>
              </select>
            </div>
            {amountMode === 'single' ? (
              <>
                <label>Amount column</label>
                {colSelect(amountCol, setAmountCol)}
                <label>Positive means</label>
                <select value={positiveIsInflow ? 'in' : 'out'} onChange={(e) => setPositiveIsInflow(e.target.value === 'in')}>
                  <option value="out">money out (outflow)</option>
                  <option value="in">money in (inflow)</option>
                </select>
              </>
            ) : (
              <>
                <label>Debit column</label>
                {colSelect(debitCol, setDebitCol)}
                <label>Credit column</label>
                {colSelect(creditCol, setCreditCol)}
              </>
            )}
            <label>Account</label>
            {creatingAcct ? (
              <div className={styles.newAcctForm}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Account name" autoFocus />
                <select
                  value={newType}
                  onChange={(e) => {
                    setNewType(e.target.value);
                    setNewSubtype(SUBTYPES[e.target.value]?.[0] ?? '');
                  }}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {(SUBTYPES[newType] ?? []).length > 0 && (
                  <select value={newSubtype} onChange={(e) => setNewSubtype(e.target.value)}>
                    {(SUBTYPES[newType] ?? []).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
                <div className={styles.inlineRow}>
                  <button className={styles.btnSecondary} onClick={() => setCreatingAcct(false)}>
                    Back
                  </button>
                  <button className={styles.btnPrimary} onClick={() => void createAccount()} disabled={!newName.trim()}>
                    Create
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.inlineRow}>
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {csvAccounts.length === 0 && <option value="">— none yet —</option>}
                  {csvAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.mask ? ` ···${a.mask}` : ''}
                    </option>
                  ))}
                </select>
                <button className={styles.btnSecondary} onClick={() => setCreatingAcct(true)}>
                  + New
                </button>
              </div>
            )}
          </div>

          {valid && (
            <div className={styles.preview}>
              <table className={styles.previewTable}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {csv.rows.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      <td className="num dim">{row[dateCol] ?? ''}</td>
                      <td>{row[nameCol] ?? ''}</td>
                      <td className="num warn">{previewAmount(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && <p className="neg">{error}</p>}
          <div className={styles.modalActions}>
            <button className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button className={styles.btnPrimary} onClick={() => void doImport()} disabled={!valid || importing}>
              {importing ? 'Importing…' : `Import ${csv.rows.length} rows`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
