import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useStatus } from '../hooks/useStatus.js';
import { Modal } from '../components/Modal.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { fmt } from '../../../../core/fmt.js';
import { mergeRules, type MergedRule } from '../../../../core/rules-merge.js';
import type { TagRuleRow, LinkedAccount } from '../../../../core/queries.js';
import type { TagOption } from '../../../../core/tags.js';
import type { TagMatchType } from '../../../../core/tag-rules.js';
import styles from './Rules.module.css';

type Tab = 'rules' | 'tags' | 'categories';

const FLEX_OPTIONS = ['', 'fixed', 'flexible', 'discretionary'] as const;

function amountLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${fmt(min, 0)}–${fmt(max, 0)}`;
  if (min !== null) return `≥ ${fmt(min, 0)}`;
  if (max !== null) return `≤ ${fmt(max, 0)}`;
  return '';
}

export function Rules() {
  const { showStatus, statusEl } = useStatus();
  const [tab, setTab] = useState<Tab>('rules');
  const [search, setSearch] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const rules = useQuery(() => api.rules.getAllRules(), [reloadKey]) ?? [];
  const nameRules = useQuery(() => api.rules.getAllNameRules(), [reloadKey]) ?? [];
  const tagRules = useQuery(() => api.rules.getAllTagRules(), [reloadKey]) ?? [];
  const tagOptions = useQuery(() => api.tags.getTagOptions(), [reloadKey]) ?? [];
  const categories = useQuery(() => api.queries.getAllCategories(), [reloadKey]) ?? [];
  const catDetails = useQuery(() => api.rules.getCategoryDetails(), [reloadKey]) ?? [];
  const hiddenSet = useQuery(() => api.queries.getHiddenCategorySet(), [reloadKey]);
  const uncategorized = useQuery(() => api.rules.getTotalUncategorizedCount(), [reloadKey]) ?? 0;
  // Not-yet-synced institution placeholders have no transactions — keep them out
  // of the account picker.
  const accounts = (useQuery(() => api.queries.getLinkedAccounts(), [reloadKey]) ?? [])
    .filter((a) => !a.awaitingFirstSync);
  const accountLabel = (id: string | null): string => {
    if (!id) return '';
    const a = accounts.find((x) => x.id === id);
    return a ? (a.nickname ?? a.name) : id;
  };

  const [ruleForm, setRuleForm] = useState<{ editing: MergedRule | null } | null>(null);
  const [tagRuleForm, setTagRuleForm] = useState<{ editing: TagRuleRow | null } | null>(null);
  const [addCatOpen, setAddCatOpen] = useState(false);
  const [renameCat, setRenameCat] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const TABS: Tab[] = ['rules', 'tags', 'categories'];
  useScreenKeys({
    Tab: () => {
      setSearch('');
      setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length]);
    },
    '/': () => searchRef.current?.focus(),
    a: () => {
      if (tab === 'rules') setRuleForm({ editing: null });
      else if (tab === 'tags') setTagRuleForm({ editing: null });
      else setAddCatOpen(true);
    },
    Escape: () => setSearch(''),
  });

  // Category rules and name rules live in separate tables, but a row that both
  // renames and categorizes a merchant is one rule to a person — merge them.
  const merged = mergeRules(rules, nameRules);

  const q = search.toLowerCase();
  const filteredMerged = q
    ? merged.filter(
        (r) =>
          r.pattern.toLowerCase().includes(q) ||
          (r.category?.toLowerCase().includes(q) ?? false) ||
          (r.replacement?.toLowerCase().includes(q) ?? false),
      )
    : merged;
  const filteredTagRules = q
    ? tagRules.filter((r) => r.pattern.toLowerCase().includes(q) || r.tag_name.toLowerCase().includes(q))
    : tagRules;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [tab] section   [/] filter   [a] add" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Rules</h1>
        <div className={styles.tabs}>
          <button className={tab === 'rules' ? styles.tabActive : styles.tab} onClick={() => setTab('rules')}>
            Rules ({merged.length})
          </button>
          <button className={tab === 'tags' ? styles.tabActive : styles.tab} onClick={() => setTab('tags')}>
            Tag rules ({tagRules.length})
          </button>
          <button className={tab === 'categories' ? styles.tabActive : styles.tab} onClick={() => setTab('categories')}>
            Categories ({catDetails.length})
          </button>
        </div>
        {tab !== 'categories' && (
          <input
            ref={searchRef}
            className={styles.search}
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('');
                searchRef.current?.blur();
              }
            }}
          />
        )}
        {uncategorized > 0 && <span className="warn">{uncategorized} uncategorized</span>}
        <button
          className={styles.addBtn}
          onClick={() => {
            if (tab === 'rules') setRuleForm({ editing: null });
            else if (tab === 'tags') setTagRuleForm({ editing: null });
            else setAddCatOpen(true);
          }}
        >
          + Add
        </button>
      </div>

      {tab === 'rules' && (
        <section className={styles.panel}>
          {filteredMerged.length === 0 ? (
            <p className="dim">{search ? 'No rules match.' : 'No rules yet.'}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Type</th>
                  <th className={styles.th}>Pattern</th>
                  <th className={styles.th}>Amount</th>
                  <th className={styles.th}>Category</th>
                  <th className={styles.th}>Display name</th>
                  <th className={styles.th}>Priority</th>
                  <th className={styles.th}>Scope</th>
                  <th className={styles.th} />
                </tr>
              </thead>
              <tbody>
                {filteredMerged.map((r) => (
                  <tr key={r.key} className={styles.row} onClick={() => setRuleForm({ editing: r })}>
                    <td className="dim">{r.matchType}</td>
                    <td className={styles.tdPattern}>{r.pattern}</td>
                    <td className="num dim">{amountLabel(r.minAmount, r.maxAmount)}</td>
                    <td className="accent">{r.category ?? ''}</td>
                    <td className="warn">{r.replacement ?? ''}</td>
                    <td className="num dim">{r.priority ?? ''}</td>
                    <td className="dim">{r.accountId ? accountLabel(r.accountId) : 'All'}</td>
                    <td className={styles.tdActions}>
                      <button
                        className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          // One row, both underlying records.
                          let recategorized: number | null = null;
                          if (r.categoryRuleId !== null) {
                            recategorized = await api.rules.deleteCategoryRule(r.categoryRuleId);
                          }
                          if (r.nameRuleId !== null) await api.rules.deleteNameRule(r.nameRuleId);
                          showStatus(
                            recategorized === null
                              ? 'Rule deleted'
                              : `Rule deleted · recategorized ${recategorized} transaction${recategorized === 1 ? '' : 's'}`,
                            3000,
                          );
                          reload();
                        }}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'tags' && (
        <section className={styles.panel}>
          {filteredTagRules.length === 0 ? (
            <p className="dim">{search ? 'No tag rules match.' : 'No tag rules yet. A rule with match type "all" + an account tags everything in that account.'}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Type</th>
                  <th className={styles.th}>Pattern</th>
                  <th className={styles.th}>Amount</th>
                  <th className={styles.th}>Tag</th>
                  <th className={styles.th}>Scope</th>
                  <th className={styles.th} />
                </tr>
              </thead>
              <tbody>
                {filteredTagRules.map((r) => (
                  <tr key={r.id} className={styles.row} onClick={() => setTagRuleForm({ editing: r })}>
                    <td className="dim">{r.match_type}</td>
                    <td className={styles.tdPattern}>{r.match_type === 'all' ? <span className="dim">— all —</span> : r.pattern}</td>
                    <td className="num dim">{amountLabel(r.min_amount, r.max_amount)}</td>
                    <td className="accent">{r.tag_name}</td>
                    <td className="dim">{r.account_id ? accountLabel(r.account_id) : 'All'}</td>
                    <td className={styles.tdActions}>
                      <button
                        className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.rules.deleteTagRule(r.id);
                          showStatus('Tag rule deleted · existing tags left in place');
                          reload();
                        }}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'categories' && (
        <section className={styles.panel}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Name</th>
                <th className={styles.th}>Flexibility</th>
                <th className={styles.th}>Visible</th>
                <th className={styles.th} />
              </tr>
            </thead>
            <tbody>
              {catDetails.map((c) => {
                const hidden = hiddenSet?.has(c.name) ?? false;
                return (
                  <tr key={c.name} className={styles.rowStatic}>
                    <td className={hidden ? 'dim' : ''}>{c.name}</td>
                    <td>
                      <select
                        className={styles.inlineSelect}
                        value={c.flexibility ?? ''}
                        style={{
                          color:
                            c.flexibility === 'fixed'
                              ? 'var(--flex-fixed)'
                              : c.flexibility === 'flexible'
                                ? 'var(--flex-flexible)'
                                : c.flexibility === 'discretionary'
                                  ? 'var(--flex-discretionary)'
                                  : 'var(--text-dim)',
                        }}
                        onChange={async (e) => {
                          await api.rules.setCategoryFlexibility(c.name, e.target.value || null);
                          reload();
                        }}
                      >
                        {FLEX_OPTIONS.map((f) => (
                          <option key={f} value={f}>
                            {f || '—'}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        className={hidden ? styles.hiddenBtn : styles.visibleBtn}
                        title={hidden ? 'Hidden from summaries — click to show' : 'Visible — click to hide from summaries'}
                        onClick={async () => {
                          if (!hiddenSet) return;
                          await api.rules.toggleHiddenCategory(c.name, hiddenSet);
                          reload();
                        }}
                      >
                        {hidden ? 'hidden' : 'visible'}
                      </button>
                    </td>
                    <td className={styles.tdActions}>
                      <button
                        className={styles.rowBtn}
                        onClick={() => setRenameCat(c.name)}
                      >
                        rename
                      </button>
                      <button
                        className={`${styles.rowBtn} ${styles.rowBtnDanger}`}
                        onClick={async () => {
                          await api.rules.deleteCategory(c.name);
                          showStatus(`Deleted "${c.name}" — its transactions are Uncategorized now`, 3000);
                          reload();
                        }}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {ruleForm && (
        <RuleFormModal
          editing={ruleForm.editing}
          categories={categories}
          accounts={accounts}
          onClose={() => setRuleForm(null)}
          onSaved={(message) => {
            setRuleForm(null);
            showStatus(message, 3000);
            reload();
          }}
        />
      )}

      {tagRuleForm && (
        <TagRuleFormModal
          editing={tagRuleForm.editing}
          tags={tagOptions}
          accounts={accounts}
          onClose={() => setTagRuleForm(null)}
          onSaved={(count) => {
            setTagRuleForm(null);
            showStatus(`Tag rule saved · tagged ${count} transaction${count === 1 ? '' : 's'}`, 3000);
            reload();
          }}
        />
      )}

      {addCatOpen && (
        <CatNameModal
          title="New category"
          initial=""
          onClose={() => setAddCatOpen(false)}
          onSave={async (name) => {
            await api.rules.createCategory(name);
            setAddCatOpen(false);
            showStatus(`Created "${name}"`);
            reload();
          }}
        />
      )}

      {renameCat && (
        <CatNameModal
          title={`Rename "${renameCat}"`}
          initial={renameCat}
          onClose={() => setRenameCat(null)}
          onSave={async (name) => {
            await api.rules.renameCategory(renameCat, name);
            setRenameCat(null);
            showStatus('Category renamed');
            reload();
          }}
        />
      )}

      {statusEl}
    </div>
  );
}

// ── Rule form (add/edit — one rule writes a category rule, a name rule, or both) ─

function RuleFormModal({
  editing,
  categories,
  accounts,
  onClose,
  onSaved,
}: {
  editing: MergedRule | null;
  categories: string[];
  accounts: LinkedAccount[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [pattern, setPattern] = useState(editing?.pattern ?? '');
  const [matchType, setMatchType] = useState<'name' | 'regex'>((editing?.matchType as 'name' | 'regex') ?? 'name');
  const [minAmount, setMinAmount] = useState(editing?.minAmount != null ? String(editing.minAmount) : '');
  const [maxAmount, setMaxAmount] = useState(editing?.maxAmount != null ? String(editing.maxAmount) : '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [replacement, setReplacement] = useState(editing?.replacement ?? '');
  const [accountId, setAccountId] = useState<string | null>(editing?.accountId ?? null);
  const [matchCount, setMatchCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (pattern.trim()) {
      api.rules
        .countPatternMatches(pattern, matchType)
        .then(setMatchCount)
        .catch(() => setMatchCount(0));
    } else {
      setMatchCount(0);
    }
  }, [pattern, matchType]);

  const displayName = replacement.trim();
  // A rule that neither categorizes nor renames does nothing — don't let it save.
  const canSave = pattern.trim().length > 0 && (category !== '' || displayName.length > 0);

  async function save() {
    if (!canSave) return;
    const min = minAmount.trim() ? parseFloat(minAmount) : null;
    const max = maxAmount.trim() ? parseFloat(maxAmount) : null;
    try {
      // Category first: both writes share the pattern, so a bad regex is
      // rejected by the first one and cannot half-apply.
      let recategorized: number | null = null;
      if (category) {
        recategorized = await api.rules.saveCategoryRule({
          pattern,
          matchType,
          category,
          minAmount: min,
          maxAmount: max,
          accountId,
          editingId: editing?.categoryRuleId ?? null,
        });
      } else if (editing?.categoryRuleId != null) {
        recategorized = await api.rules.deleteCategoryRule(editing.categoryRuleId);
      }

      if (displayName) {
        await api.rules.saveNameRule({
          pattern,
          matchType,
          replacement: displayName,
          minAmount: min,
          maxAmount: max,
          accountId,
          editingId: editing?.nameRuleId ?? null,
        });
      } else if (editing?.nameRuleId != null) {
        await api.rules.deleteNameRule(editing.nameRuleId);
      }

      const parts = ['Rule saved'];
      if (recategorized !== null) {
        parts.push(`recategorized ${recategorized} transaction${recategorized === 1 ? '' : 's'}`);
      }
      if (displayName) parts.push(`shown as "${displayName}"`);
      onSaved(parts.join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save rule');
    }
  }

  return (
    <Modal title={editing ? 'Edit rule' : 'New rule'} onClose={onClose} accent="var(--manual)">
      <div className={styles.formGrid}>
        <label>Pattern</label>
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} autoFocus placeholder="e.g. UBER or ^AMZN" />
        <label>Match type</label>
        <select value={matchType} onChange={(e) => setMatchType(e.target.value as 'name' | 'regex')}>
          <option value="name">name (substring)</option>
          <option value="regex">regex</option>
        </select>
        <label>Min $ (optional)</label>
        <input value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        <label>Max $ (optional)</label>
        <input value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{editing?.categoryRuleId != null ? '— none (removes rule) —' : '— none —'}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label>Display name</label>
        <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="e.g. Amazon" />
        <label>Account</label>
        <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname ?? a.name}
            </option>
          ))}
        </select>
      </div>
      {pattern.trim() && (
        <p className={styles.matchHint}>
          <span className="warn">{matchCount} transactions match</span>
          {category && <span className="dim"> · saving recategorizes them</span>}
        </p>
      )}
      {error && <p className="neg">{error}</p>}
      {pattern.trim() && !canSave && (
        <p className={styles.saveHint}>Pick a category or enter a display name to save.</p>
      )}
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()} disabled={!canSave}>
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── Tag rule form ────────────────────────────────────────────────────────────

function TagRuleFormModal({
  editing,
  tags,
  accounts,
  onClose,
  onSaved,
}: {
  editing: TagRuleRow | null;
  tags: TagOption[];
  accounts: LinkedAccount[];
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const [matchType, setMatchType] = useState<TagMatchType>((editing?.match_type as TagMatchType) ?? 'all');
  const [pattern, setPattern] = useState(editing?.pattern ?? '');
  const [minAmount, setMinAmount] = useState(editing?.min_amount != null ? String(editing.min_amount) : '');
  const [maxAmount, setMaxAmount] = useState(editing?.max_amount != null ? String(editing.max_amount) : '');
  const [tagId, setTagId] = useState<number | null>(editing?.tag_id ?? tags[0]?.id ?? null);
  const [accountId, setAccountId] = useState<string | null>(editing?.account_id ?? null);
  const [matchCount, setMatchCount] = useState(0);
  const [error, setError] = useState('');

  const needsPattern = matchType !== 'all';

  useEffect(() => {
    if (needsPattern && !pattern.trim()) { setMatchCount(0); return; }
    api.rules
      .countTagRuleMatches(
        matchType,
        pattern,
        accountId,
        minAmount.trim() ? parseFloat(minAmount) : null,
        maxAmount.trim() ? parseFloat(maxAmount) : null,
      )
      .then(setMatchCount)
      .catch(() => setMatchCount(0));
  }, [matchType, pattern, accountId, needsPattern, minAmount, maxAmount]);

  const canSave = tagId !== null && (!needsPattern || pattern.trim().length > 0);

  async function save() {
    if (!canSave || tagId === null) return;
    try {
      const count = await api.rules.saveTagRule({
        matchType,
        pattern,
        tagId,
        minAmount: minAmount.trim() ? parseFloat(minAmount) : null,
        maxAmount: maxAmount.trim() ? parseFloat(maxAmount) : null,
        accountId,
        editingId: editing?.id ?? null,
      });
      onSaved(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save tag rule');
    }
  }

  return (
    <Modal title={editing ? 'Edit tag rule' : 'New tag rule'} onClose={onClose} accent="var(--accent)">
      <div className={styles.formGrid}>
        <label>Match type</label>
        <select value={matchType} onChange={(e) => setMatchType(e.target.value as TagMatchType)}>
          <option value="all">all (every transaction in scope)</option>
          <option value="name">name (substring)</option>
          <option value="regex">regex</option>
        </select>
        {needsPattern && (
          <>
            <label>Pattern</label>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} autoFocus placeholder="e.g. AMZN or ^AMZN" />
          </>
        )}
        <label>Min $ (optional)</label>
        <input value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        <label>Max $ (optional)</label>
        <input value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        <label>Tag</label>
        <select value={tagId ?? ''} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}>
          {tags.length === 0 && <option value="">No tags yet — create one first</option>}
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <label>Account</label>
        <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname ?? a.name}
            </option>
          ))}
        </select>
      </div>
      {(!needsPattern || pattern.trim()) && (
        <p className={styles.matchHint}>
          <span className="warn">{matchCount} transactions match</span>
          <span className="dim"> · saving tags them (removed tags stay removed)</span>
        </p>
      )}
      {error && <p className="neg">{error}</p>}
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => void save()} disabled={!canSave}>
          Save
        </button>
      </div>
    </Modal>
  );
}

// ── Category name modal (add / rename) ──────────────────────────────────────

function CatNameModal({
  title,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) onSave(name.trim());
        }}
        placeholder="Category name"
        autoFocus
        className={styles.modalInput}
      />
      <div className={styles.modalActions}>
        <button className={styles.btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button className={styles.btnPrimary} onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
