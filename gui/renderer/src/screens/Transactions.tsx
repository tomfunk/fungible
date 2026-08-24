import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useStatus } from '../hooks/useStatus.js';
import { useNav } from '../hooks/useNav.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { Modal } from '../components/Modal.js';
import { MONTHS } from '../../../../core/dateUtils.js';
import type { SortMode, TxRow } from '../../../../core/queries.js';
import { isFilterActive } from '../../../../core/filters.js';
import { useFilter } from '../hooks/useFilter.js';
import { useLoadGuard } from '../hooks/useLoadGuard.js';
import type { TagOption } from '../../../../core/tags.js';
import { fmtTimeAgo } from '../../../../core/fmt.js';
import styles from './Transactions.module.css';

function fmtAmount(amount: number) {
  const s = `$${Math.abs(amount).toFixed(2)}`;
  return amount < 0 ? `+${s}` : `-${s}`;
}

type SortCol = 'date' | 'name' | 'amount' | 'category';

const SORT_DEFAULT_DESC: Record<SortCol, boolean> = {
  date: true,
  name: false,
  amount: true,
  category: false,
};

export function Transactions() {
  const { txFilter, navigate } = useNav();
  const { showStatus, statusEl } = useStatus();

  const [from, setFrom] = useState<string | null>(txFilter.from ?? null);
  const [to, setTo] = useState<string | null>(txFilter.to ?? null);
  const [txType, setTxType] = useState<'income' | 'expenses' | null>(txFilter.txType ?? null);
  const [flex, setFlex] = useState<'fixed' | 'flexible' | 'discretionary' | null>(txFilter.flex ?? null);
  const [search, setSearch] = useState(txFilter.search ?? '');
  const [sort, setSort] = useState<SortMode>('date-desc');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);
  const [syncing, setSyncing] = useState(false);

  const bounds = useQuery(() => api.queries.getDataBounds(), []);
  const categories = useQuery(() => api.queries.getAllCategories(), [reloadKey]) ?? [];
  const lastSynced = useQuery(() => api.sync.getLastSyncedAt(), [reloadKey]);
  const filterOptions = useQuery(() => api.queries.getFilterOptions(), [reloadKey]);
  const { filter: sharedFilter, setFilter, popFilter, canPop } = useFilter();
  const txs =
    useQuery(
      () => api.queries.getTransactions({ filter: sharedFilter, from, to, search, sort, txType, flex }),
      [from, to, search, sort, txType, flex, sharedFilter, reloadKey],
    ) ?? [];

  // ── Modals ──
  const [editTx, setEditTx] = useState<TxRow | null>(null);
  const [tagTx, setTagTx] = useState<TxRow | null>(null);
  const [bulkTag, setBulkTag] = useState(false);
  const [bulkCat, setBulkCat] = useState(false);

  async function forceSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const results = await api.sync.syncAll(true);
      const added = results.reduce((s, r) => s + r.added, 0);
      showStatus(`Sync done — ${added} new transaction${added === 1 ? '' : 's'}`, 4000);
      reload();
    } catch {
      showStatus('Sync failed', 3000);
    } finally {
      setSyncing(false);
    }
  }

  function sortHeader(col: SortCol, label: string, alignRight = false) {
    const active = sort.startsWith(col);
    const desc = sort === `${col}-desc`;
    return (
      <th
        className={`${active ? styles.thActive : styles.th} ${alignRight ? styles.thRight : ''}`}
        onClick={() =>
          setSort(active ? (`${col}-${desc ? 'asc' : 'desc'}` as SortMode) : (`${col}-${SORT_DEFAULT_DESC[col] ? 'desc' : 'asc'}` as SortMode))
        }
      >
        {label} {active ? (desc ? '↓' : '↑') : ''}
      </th>
    );
  }

  function navMonth(delta: -1 | 1) {
    if (!from) return;
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = parseInt(from.slice(0, 4));
    const m = parseInt(from.slice(5, 7));
    const nm = delta === -1 ? (m === 1 ? 12 : m - 1) : m === 12 ? 1 : m + 1;
    const ny = delta === -1 ? (m === 1 ? y - 1 : y) : m === 12 ? y + 1 : y;
    const newFrom = `${ny}-${pad(nm)}-01`;
    if (bounds && delta === -1 && newFrom < bounds.minDate) return;
    if (bounds && delta === 1 && newFrom > bounds.maxDate) return;
    setFrom(newFrom);
    setTo(`${ny}-${pad(nm)}-31`);
  }

  function dateLabel(): string | null {
    if (!from) return null;
    const y = from.slice(0, 4);
    const m = parseInt(from.slice(5, 7));
    if (to && from === `${y}-${String(m).padStart(2, '0')}-01` && to.slice(0, 7) === from.slice(0, 7)) {
      return `${MONTHS[m - 1]} ${y}`;
    }
    return `${from} – ${to ?? ''}`;
  }

  function clearAll() {
    setSearch('');
    setFrom(null);
    setTo(null);
    setTxType(null);
    setFlex(null);
    setFilter({});
  }

  const searchRef = useRef<HTMLInputElement>(null);
  const SORT_CYCLE: SortMode[] = [
    'date-desc', 'date-asc', 'name-asc', 'name-desc',
    'amount-desc', 'amount-asc', 'category-asc', 'category-desc',
  ];
  useScreenKeys({
    '/': () => searchRef.current?.focus(),
    s: () => setSort((s) => SORT_CYCLE[(SORT_CYCLE.indexOf(s) + 1) % SORT_CYCLE.length]),
    u: () => {
      setSearch('');
      setFrom(null);
      setTo(null);
      setFilter({ ...sharedFilter, categories: ['Uncategorized'] });
    },
    a: () => clearAll(),
    ArrowLeft: () => navMonth(-1),
    ArrowRight: () => navMonth(1),
    Escape: () => {
      // Arriving via a drill-in is reversed as a unit: pop the filter level
      // the drill pushed and return to its screen (same semantics as the TUI).
      if (txFilter.drillFrom) {
        popFilter();
        navigate(txFilter.drillFrom, { range: txFilter.range, anchor: from ?? txFilter.anchor });
        return;
      }
      if (search) setSearch('');
      else if (from) {
        setFrom(null);
        setTo(null);
      } else if (canPop || isFilterActive(sharedFilter)) popFilter();
      else navigate('dashboard', { range: txFilter.range, anchor: from ?? txFilter.anchor });
    },
  });

  // One chip per active shared-filter dimension (removal drops just that
  // dimension), plus the screen-local txType/flex chips.
  function dropDim(dim: 'categories' | 'accounts' | 'owners' | 'tags') {
    const next = { ...sharedFilter };
    delete next[dim];
    setFilter(next);
  }
  const acctName = (id: string) => filterOptions?.accounts.find((a) => a.id === id)?.name ?? id;
  const chips: Array<{ label: string; remove: () => void }> = [];
  if (sharedFilter.accounts) {
    const a = sharedFilter.accounts;
    chips.push({ label: a.length === 1 ? acctName(a[0]) : `${a.length} accounts`, remove: () => dropDim('accounts') });
  }
  if (sharedFilter.owners) {
    const o = sharedFilter.owners;
    chips.push({ label: o.length === 1 ? o[0] : `${o.length} owners`, remove: () => dropDim('owners') });
  }
  for (const t of sharedFilter.tags ?? []) {
    chips.push({
      label: `${t.mode === 'lacks' ? '✗' : ''}#${t.name}`,
      remove: () => {
        const rest = (sharedFilter.tags ?? []).filter((p) => p.name !== t.name);
        setFilter({ ...sharedFilter, ...(rest.length ? { tags: rest } : { tags: undefined }) });
      },
    });
  }
  if (sharedFilter.categories) {
    const c = sharedFilter.categories;
    chips.push({ label: c.length === 1 ? c[0] : `${c.length} categories`, remove: () => dropDim('categories') });
  }
  if (txType) chips.push({ label: txType, remove: () => setTxType(null) });
  if (flex) chips.push({ label: flex, remove: () => setFlex(null) });
  const dl = dateLabel();

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [/] search   [s] sort   [u] uncategorized   [a] all   [← →] month   [esc] clear" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Transactions</h1>
        <input
          ref={searchRef}
          className={styles.search}
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearch('');
              searchRef.current?.blur();
            }
          }}
        />
        <div className={styles.quickFilters}>
          <button
            className={sharedFilter.categories?.length === 1 && sharedFilter.categories[0] === 'Uncategorized' ? styles.qfActive : styles.qf}
            onClick={() => {
              setSearch('');
              setFrom(null);
              setTo(null);
              setFilter({ ...sharedFilter, categories: ['Uncategorized'] });
            }}
          >
            Uncategorized
          </button>
          <button className={styles.qf} onClick={clearAll}>
            All
          </button>
        </div>
        <div className={styles.syncRow}>
          <button className={styles.syncBtn} onClick={() => void forceSync()} disabled={syncing}>
            {syncing ? 'Syncing…' : '⟳ Sync'}
          </button>
          {lastSynced !== undefined && (
            <span className="dim">Last synced {fmtTimeAgo(lastSynced ?? null)}</span>
          )}
        </div>
      </div>

      {(chips.length > 0 || dl) && (
        <div className={styles.chips}>
          {dl && (
            <span className={styles.chipDate}>
              <button className={styles.chipNav} onClick={() => navMonth(-1)}>
                ‹
              </button>
              {dl}
              <button className={styles.chipNav} onClick={() => navMonth(1)}>
                ›
              </button>
              <button className={styles.chipX} onClick={() => { setFrom(null); setTo(null); }}>
                ✕
              </button>
            </span>
          )}
          {chips.map((c) => (
            <span key={c.label} className={styles.chip}>
              {c.label}
              <button className={styles.chipX} onClick={c.remove}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.bulkBar}>
        <span className="dim">
          {txs.length} transaction{txs.length === 1 ? '' : 's'}
          {txs.length === 200 ? ' (limit 200)' : ''}
        </span>
        {txs.length > 0 && (
          <div className={styles.bulkBtns}>
            <button className={styles.bulkBtn} onClick={() => setBulkCat(true)}>
              Categorize all
            </button>
            <button className={styles.bulkBtn} onClick={() => setBulkTag(true)}>
              Tag all
            </button>
            <button
              className={styles.bulkBtn}
              onClick={async () => {
                const count = txs.filter((t) => t.manual_category).length;
                await api.transactions.clearOverridesBulk(txs.map((t) => t.id));
                showStatus(`Cleared overrides on ${count} transaction${count === 1 ? '' : 's'}`, 2500);
                reload();
              }}
            >
              Clear overrides
            </button>
            <button
              className={styles.bulkBtn}
              onClick={async () => {
                const target = !txs[0]?.ignored;
                await api.transactions.setIgnoredBulk(txs.map((t) => t.id), target);
                showStatus(`${target ? 'Ignored' : 'Un-ignored'} ${txs.length} transaction${txs.length === 1 ? '' : 's'}`, 2500);
                reload();
              }}
            >
              {txs[0]?.ignored ? 'Un-ignore all' : 'Ignore all'}
            </button>
          </div>
        )}
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            {sortHeader('date', 'Date')}
            {sortHeader('name', 'Description')}
            {sortHeader('amount', 'Amount', true)}
            {sortHeader('category', 'Category')}
            <th className={styles.th}>Tags</th>
            <th className={styles.th} />
          </tr>
        </thead>
        <tbody>
          {txs.map((tx) => {
            const isPinned = !!tx.manual_category;
            const isIgnored = !!tx.ignored;
            return (
              <tr
                key={tx.id}
                className={`${styles.row} ${isIgnored ? styles.rowIgnored : ''}`}
                onClick={() => setEditTx(tx)}
              >
                <td className={`num ${styles.tdDate}`}>{tx.date}</td>
                <td className={styles.tdDesc}>{tx.display_name ?? tx.merchant_name ?? tx.name}</td>
                <td className={`num ${styles.tdAmount} ${!isIgnored && tx.amount < 0 ? 'pos' : ''}`}>
                  {fmtAmount(tx.amount)}
                </td>
                <td
                  className={`${styles.tdCat} ${
                    isIgnored ? '' : tx.category === 'Uncategorized' ? 'warn' : isPinned ? 'manual' : ''
                  }`}
                  title={isPinned ? 'Manually categorized' : undefined}
                >
                  {isPinned ? '◆ ' : ''}
                  {isIgnored ? '~ ' : ''}
                  {tx.category}
                </td>
                <td className={`${styles.tdTags} accent`}>{tx.tag_names ?? ''}</td>
                <td className={styles.tdActions}>
                  <button
                    className={styles.rowBtn}
                    title="Tags"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTagTx(tx);
                    }}
                  >
                    tag
                  </button>
                  <button
                    className={styles.rowBtn}
                    title={isIgnored ? 'Un-ignore' : 'Ignore (exclude from totals)'}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api.transactions.setTransactionIgnored(tx.id, !isIgnored);
                      reload();
                    }}
                  >
                    {isIgnored ? 'unignore' : 'ignore'}
                  </button>
                  {isPinned && (
                    <button
                      className={styles.rowBtn}
                      title="Clear manual category override"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.transactions.clearTransactionOverride(tx.id);
                        showStatus('Override cleared');
                        reload();
                      }}
                    >
                      clear
                    </button>
                  )}
                  {tx.source === 'csv' && (
                    <button
                      className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                      title="Delete (CSV-imported only)"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.transactions.deleteTransaction(tx.id);
                        showStatus('Transaction deleted');
                        reload();
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
      {txs.length === 0 && <p className="dim">No transactions match the current filters.</p>}

      {editTx && (
        <EditModal
          tx={editTx}
          categories={categories}
          onClose={() => setEditTx(null)}
          onSaved={(msg) => {
            setEditTx(null);
            showStatus(msg, 3000);
            reload();
          }}
        />
      )}

      {tagTx && (
        <TagModal
          tx={tagTx}
          onClose={() => {
            setTagTx(null);
            reload();
          }}
        />
      )}

      {bulkCat && (
        <BulkCategoryModal
          categories={categories}
          count={txs.length}
          onClose={() => setBulkCat(false)}
          onPick={async (cat) => {
            await api.transactions.setTransactionCategoryBulk(txs.map((t) => t.id), cat);
            setBulkCat(false);
            showStatus(`Set category to "${cat}" for ${txs.length} transaction${txs.length === 1 ? '' : 's'}`, 3000);
            reload();
          }}
        />
      )}

      {bulkTag && (
        <BulkTagModal
          count={txs.length}
          onClose={() => setBulkTag(false)}
          onPick={async (tagId) => {
            await api.tags.addTagToTransactions(txs.map((t) => t.id), tagId);
            setBulkTag(false);
            showStatus(`Tagged ${txs.length} transaction${txs.length === 1 ? '' : 's'}`, 2500);
            reload();
          }}
        />
      )}

      {statusEl}
    </div>
  );
}

// ── Edit modal ──────────────────────────────────────────────────────────────

function EditModal({
  tx,
  categories,
  onClose,
  onSaved,
}: {
  tx: TxRow;
  categories: string[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [cat, setCat] = useState(tx.category);
  const [pattern, setPattern] = useState('');
  const [matchType, setMatchType] = useState<'name' | 'regex'>('name');
  const [matchCount, setMatchCount] = useState(0);
  const [error, setError] = useState('');
  const matchGuard = useLoadGuard();

  useEffect(() => {
    if (pattern.trim()) {
      const token = matchGuard.begin();
      void api.rules.countPatternMatches(pattern, matchType)
        .then((count) => { if (matchGuard.isLatest(token)) setMatchCount(count); });
    } else {
      setMatchCount(0);
    }
  }, [pattern, matchType]);

  async function save() {
    const newDisplay = name.trim();
    const nameChanged = newDisplay.length > 0;
    const catChanged = cat !== tx.category;

    if (pattern.trim()) {
      const saved: string[] = [];
      try {
        if (catChanged) {
          const count = await api.transactions.upsertCategoryRule(pattern, matchType, cat);
          saved.push(`category rule (${count} updated)`);
        }
        if (nameChanged) {
          await api.transactions.upsertNameRule(pattern, matchType, newDisplay);
          saved.push('name rule');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save rule');
        return;
      }
      onSaved(saved.length ? `Saved: ${saved.join(' + ')}` : 'No changes');
    } else {
      if (nameChanged) await api.transactions.setTransactionDisplayName(tx.id, newDisplay);
      if (catChanged) await api.transactions.setTransactionCategory(tx.id, cat);
      onSaved(nameChanged || catChanged ? 'Transaction updated' : 'No changes');
    }
  }

  const isRule = !!pattern.trim();

  return (
    <Modal title={<>Edit <span className="dim">{tx.name}</span></>} onClose={onClose} accent={isRule ? 'var(--manual)' : undefined}>
      <div className={styles.formGrid}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="(unchanged)" autoFocus />
        <label>Category</label>
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label>Pattern</label>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="optional — saves as rule"
        />
        <label>Match type</label>
        <select value={matchType} onChange={(e) => setMatchType(e.target.value as 'name' | 'regex')}>
          <option value="name">name</option>
          <option value="regex">regex</option>
        </select>
      </div>
      {isRule && (
        <p className={styles.ruleHint}>
          <span className="warn">{matchCount} transactions match</span>
          <span className="dim"> · saving creates a rule applied to all of them</span>
        </p>
      )}
      {error && <p className="neg">{error}</p>}
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()}>
          {isRule ? 'Save as rule' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

// ── Tag modal ───────────────────────────────────────────────────────────────

function TagModal({ tx, onClose }: { tx: TxRow; onClose: () => void }) {
  const [allTags, setAllTags] = useState<TagOption[]>([]);
  const [txTagIds, setTxTagIds] = useState<Set<number>>(new Set());
  const [input, setInput] = useState('');

  async function refresh() {
    const [tags, ids] = await Promise.all([api.tags.getTagOptions(), api.tags.getTransactionTagIds(tx.id)]);
    setAllTags(tags);
    setTxTagIds(ids);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.id]);

  const filteredTags = input ? allTags.filter((t) => t.name.toLowerCase().includes(input.toLowerCase())) : allTags;
  const exactMatch = allTags.some((t) => t.name.toLowerCase() === input.trim().toLowerCase());

  async function toggle(tagId: number) {
    if (txTagIds.has(tagId)) {
      await api.tags.removeTagFromTransaction(tx.id, tagId);
    } else {
      await api.tags.addTagToTransaction(tx.id, tagId);
    }
    await refresh();
  }

  async function createAndApply() {
    const name = input.trim();
    if (!name) return;
    const tagId = await api.tags.getOrCreateTag(name);
    await api.tags.addTagToTransaction(tx.id, tagId);
    setInput('');
    await refresh();
  }

  return (
    <Modal title={<>Tags <span className="dim">{tx.display_name ?? tx.name}</span></>} onClose={onClose} accent="var(--warning)">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim() && !exactMatch) void createAndApply();
        }}
        placeholder="Filter or create…"
        autoFocus
        className={styles.tagInput}
      />
      <div className={styles.tagList}>
        {filteredTags.map((t) => {
          const has = txTagIds.has(t.id);
          return (
            <button key={t.id} className={has ? styles.tagRowOn : styles.tagRow} onClick={() => void toggle(t.id)}>
              <span>{has ? '●' : '○'}</span> {t.name}
            </button>
          );
        })}
        {filteredTags.length === 0 && input.trim() && (
          <button className={styles.tagRow} onClick={() => void createAndApply()}>
            + create “{input.trim()}”
          </button>
        )}
        {allTags.length === 0 && !input && <p className="dim">No tags yet — type a name and press Enter.</p>}
      </div>
    </Modal>
  );
}

// ── Bulk modals ─────────────────────────────────────────────────────────────

function BulkCategoryModal({
  categories,
  count,
  onClose,
  onPick,
}: {
  categories: string[];
  count: number;
  onClose: () => void;
  onPick: (cat: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const visible = filter ? categories.filter((c) => c.toLowerCase().includes(filter.toLowerCase())) : categories;
  return (
    <Modal title={`Set category for ${count} visible transaction${count === 1 ? '' : 's'}`} onClose={onClose} accent="var(--manual)">
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" autoFocus className={styles.tagInput} />
      <div className={styles.tagList}>
        {visible.map((c) => (
          <button key={c} className={styles.tagRow} onClick={() => onPick(c)}>
            {c}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function BulkTagModal({
  count,
  onClose,
  onPick,
}: {
  count: number;
  onClose: () => void;
  onPick: (tagId: number) => void;
}) {
  const [allTags, setAllTags] = useState<TagOption[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    void api.tags.getTagOptions().then(setAllTags);
  }, []);

  const filteredTags = input ? allTags.filter((t) => t.name.toLowerCase().includes(input.toLowerCase())) : allTags;

  async function createAndApply() {
    const name = input.trim();
    if (!name) return;
    onPick(await api.tags.getOrCreateTag(name));
  }

  return (
    <Modal title={`Tag ${count} visible transaction${count === 1 ? '' : 's'}`} onClose={onClose}>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim() && filteredTags.length === 0) void createAndApply();
        }}
        placeholder="Filter or create…"
        autoFocus
        className={styles.tagInput}
      />
      <div className={styles.tagList}>
        {filteredTags.map((t) => (
          <button key={t.id} className={styles.tagRow} onClick={() => onPick(t.id)}>
            {t.name}
          </button>
        ))}
        {filteredTags.length === 0 && input.trim() && (
          <button className={styles.tagRow} onClick={() => void createAndApply()}>
            + create & apply “{input.trim()}”
          </button>
        )}
      </div>
    </Modal>
  );
}
