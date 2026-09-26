import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useStatus } from '../hooks/useStatus.js';
import { Modal } from '../components/Modal.js';
import { NameModal } from '../components/NameModal.js';
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
        <div className="tabGroup">
          <button className={tab === 'rules' ? 'tabActive' : 'tab'} onClick={() => setTab('rules')}>
            Rules ({merged.length})
          </button>
          <button className={tab === 'tags' ? 'tabActive' : 'tab'} onClick={() => setTab('tags')}>
            Tag rules ({tagRules.length})
          </button>
          <button className={tab === 'categories' ? 'tabActive' : 'tab'} onClick={() => setTab('categories')}>
            Categories ({catDetails.length})
          </button>
        </div>
        {tab !== 'categories' && (
          <input
            ref={searchRef}
            className={`underline ${styles.search}`}
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
          className={`ghostBtn ${styles.addBtn}`}
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
          mode={{ kind: 'category', editing: ruleForm.editing, categories, accounts }}
          onClose={() => setRuleForm(null)}
          onSaved={(message) => {
            setRuleForm(null);
            showStatus(message, 3000);
            reload();
          }}
        />
      )}

      {tagRuleForm && (
        <RuleFormModal
          mode={{ kind: 'tag', editing: tagRuleForm.editing, tags: tagOptions, accounts }}
          onClose={() => setTagRuleForm(null)}
          onSaved={(message) => {
            setTagRuleForm(null);
            showStatus(message, 3000);
            reload();
          }}
        />
      )}

      {addCatOpen && (
        <NameModal
          title="New category"
          initial=""
          placeholder="Category name"
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
        <NameModal
          title={`Rename "${renameCat}"`}
          initial={renameCat}
          placeholder="Category name"
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

// ── Rule form (add/edit) ─────────────────────────────────────────────────────
// One shared form for both rule kinds: a category rule (which writes a
// category rule, a name rule, or both against the same pattern) and a tag
// rule. They differ in which fields exist (category+display-name vs. tag,
// "all" as a match type, live-match-count query and its dependencies, and
// the save/error copy) — `mode` carries exactly those differences so each
// call site keeps its pre-merge behavior, including field ORDER (the
// category form shows Pattern before Match type; the tag form shows Match
// type before an optionally-hidden Pattern) and which state changes
// re-trigger the live match count.

type RuleFormMode =
  | { kind: 'category'; editing: MergedRule | null; categories: string[]; accounts: LinkedAccount[] }
  | { kind: 'tag'; editing: TagRuleRow | null; tags: TagOption[]; accounts: LinkedAccount[] };

function RuleFormModal({
  mode,
  onClose,
  onSaved,
}: {
  mode: RuleFormMode;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [pattern, setPattern] = useState(mode.editing?.pattern ?? '');
  const [matchType, setMatchType] = useState<TagMatchType>(
    mode.kind === 'tag' ? ((mode.editing?.match_type as TagMatchType) ?? 'all') : ((mode.editing?.matchType as TagMatchType) ?? 'name'),
  );
  const [minAmount, setMinAmount] = useState(
    mode.kind === 'tag'
      ? (mode.editing?.min_amount != null ? String(mode.editing.min_amount) : '')
      : (mode.editing?.minAmount != null ? String(mode.editing.minAmount) : ''),
  );
  const [maxAmount, setMaxAmount] = useState(
    mode.kind === 'tag'
      ? (mode.editing?.max_amount != null ? String(mode.editing.max_amount) : '')
      : (mode.editing?.maxAmount != null ? String(mode.editing.maxAmount) : ''),
  );
  const [accountId, setAccountId] = useState<string | null>(
    mode.kind === 'tag' ? (mode.editing?.account_id ?? null) : (mode.editing?.accountId ?? null),
  );
  const [category, setCategory] = useState(mode.kind === 'category' ? (mode.editing?.category ?? '') : '');
  const [replacement, setReplacement] = useState(mode.kind === 'category' ? (mode.editing?.replacement ?? '') : '');
  const [tagId, setTagId] = useState<number | null>(
    mode.kind === 'tag' ? (mode.editing?.tag_id ?? mode.tags[0]?.id ?? null) : null,
  );
  const [matchCount, setMatchCount] = useState(0);
  const [error, setError] = useState('');

  const needsPattern = matchType !== 'all'; // only ever 'all' in tag mode — always true for category
  const displayName = replacement.trim();

  // Category mode's live match count: unchanged from the pre-merge effect —
  // countPatternMatches only takes pattern/matchType, so account/amount edits
  // never re-trigger it.
  useEffect(() => {
    if (mode.kind !== 'category') return;
    if (pattern.trim()) {
      api.rules
        .countPatternMatches(pattern, matchType as 'name' | 'regex')
        .then(setMatchCount)
        .catch(() => setMatchCount(0));
    } else {
      setMatchCount(0);
    }
  }, [mode.kind, pattern, matchType]);

  // Tag mode's live match count: unchanged from the pre-merge effect —
  // countTagRuleMatches also takes account/amount, so those re-trigger it too.
  useEffect(() => {
    if (mode.kind !== 'tag') return;
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
  }, [mode.kind, needsPattern, pattern, matchType, accountId, minAmount, maxAmount]);

  const canSave =
    mode.kind === 'category'
      // A rule that neither categorizes nor renames does nothing — don't let it save.
      ? pattern.trim().length > 0 && (category !== '' || displayName.length > 0)
      : tagId !== null && (!needsPattern || pattern.trim().length > 0);

  async function save() {
    if (!canSave) return;
    const min = minAmount.trim() ? parseFloat(minAmount) : null;
    const max = maxAmount.trim() ? parseFloat(maxAmount) : null;
    try {
      if (mode.kind === 'category') {
        // Category first: both writes share the pattern, so a bad regex is
        // rejected by the first one and cannot half-apply.
        let recategorized: number | null = null;
        if (category) {
          recategorized = await api.rules.saveCategoryRule({
            pattern,
            matchType: matchType as 'name' | 'regex',
            category,
            minAmount: min,
            maxAmount: max,
            accountId,
            editingId: mode.editing?.categoryRuleId ?? null,
          });
        } else if (mode.editing?.categoryRuleId != null) {
          recategorized = await api.rules.deleteCategoryRule(mode.editing.categoryRuleId);
        }

        if (displayName) {
          await api.rules.saveNameRule({
            pattern,
            matchType: matchType as 'name' | 'regex',
            replacement: displayName,
            minAmount: min,
            maxAmount: max,
            accountId,
            editingId: mode.editing?.nameRuleId ?? null,
          });
        } else if (mode.editing?.nameRuleId != null) {
          await api.rules.deleteNameRule(mode.editing.nameRuleId);
        }

        const parts = ['Rule saved'];
        if (recategorized !== null) {
          parts.push(`recategorized ${recategorized} transaction${recategorized === 1 ? '' : 's'}`);
        }
        if (displayName) parts.push(`shown as "${displayName}"`);
        onSaved(parts.join(' · '));
      } else {
        if (tagId === null) return;
        const count = await api.rules.saveTagRule({
          matchType,
          pattern,
          tagId,
          minAmount: min,
          maxAmount: max,
          accountId,
          editingId: mode.editing?.id ?? null,
        });
        onSaved(`Tag rule saved · tagged ${count} transaction${count === 1 ? '' : 's'}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : mode.kind === 'category' ? 'Failed to save rule' : 'Failed to save tag rule');
    }
  }

  return (
    <Modal
      title={
        mode.kind === 'category'
          ? mode.editing ? 'Edit rule' : 'New rule'
          : mode.editing ? 'Edit tag rule' : 'New tag rule'
      }
      onClose={onClose}
      accent={mode.kind === 'category' ? 'var(--manual)' : 'var(--accent)'}
    >
      <div className={styles.formGrid}>
        {mode.kind === 'category' ? (
          <>
            <label>Pattern</label>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} autoFocus placeholder="e.g. UBER or ^AMZN" />
            <label>Match type</label>
            <select value={matchType} onChange={(e) => setMatchType(e.target.value as TagMatchType)}>
              <option value="name">name (substring)</option>
              <option value="regex">regex</option>
            </select>
          </>
        ) : (
          <>
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
          </>
        )}
        <label>Min $ (optional)</label>
        <input value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        <label>Max $ (optional)</label>
        <input value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d.\-]/g, ''))} />
        {mode.kind === 'category' ? (
          <>
            <label>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">{mode.editing?.categoryRuleId != null ? '— none (removes rule) —' : '— none —'}</option>
              {mode.categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label>Display name</label>
            <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="e.g. Amazon" />
          </>
        ) : (
          <>
            <label>Tag</label>
            <select value={tagId ?? ''} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}>
              {mode.tags.length === 0 && <option value="">No tags yet — create one first</option>}
              {mode.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        )}
        <label>Account</label>
        <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value || null)}>
          <option value="">All accounts</option>
          {mode.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nickname ?? a.name}
            </option>
          ))}
        </select>
      </div>
      {mode.kind === 'category' ? (
        pattern.trim() && (
          <p className={styles.matchHint}>
            <span className="warn">{matchCount} transactions match</span>
            {category && <span className="dim"> · saving recategorizes them</span>}
          </p>
        )
      ) : (
        (!needsPattern || pattern.trim()) && (
          <p className={styles.matchHint}>
            <span className="warn">{matchCount} transactions match</span>
            <span className="dim"> · saving tags them (removed tags stay removed)</span>
          </p>
        )
      )}
      {error && <p className="neg">{error}</p>}
      {mode.kind === 'category' && pattern.trim() && !canSave && (
        <p className={styles.saveHint}>Pick a category or enter a display name to save.</p>
      )}
      <div className="modalActions">
        <button className="btnSecondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btnPrimary" onClick={() => void save()} disabled={!canSave}>
          Save
        </button>
      </div>
    </Modal>
  );
}
