import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useFilter } from '../hooks/useFilter.js';
import { Modal } from './Modal.js';
import {
  EMPTY_FILTER,
  isFilterActive,
  filterSummary,
  selectionToDim,
  selectionFromDim,
  invertSelection,
  invertTagModes,
  filtersEqual,
  type Filter,
  type TagPredicate,
} from '../../../../core/filters.js';
import type { FilterOptions } from '../../../../core/queries.js';
import styles from './FilterBar.module.css';

// Debounce window for publishing the live preview. Toggling many checkboxes in
// quick succession (or hitting all/none/invert) mutates the draft repeatedly;
// coalescing them collapses the burst into one query round-trip per pause
// instead of one per keystroke. Mirrors PREVIEW_DEBOUNCE_MS in tui/FilterPanel.
const PREVIEW_DEBOUNCE_MS = 120;

export function FilterBar() {
  const { filter, committed, setFilter } = useFilter();
  const [open, setOpen] = useState(false);
  const active = isFilterActive(filter);

  return (
    <div className={styles.bar}>
      <button className={active ? styles.filterBtnActive : styles.filterBtn} onClick={() => setOpen(true)}>
        ⚲ Filter{active ? `: ${filterSummary(filter)}` : ''}
      </button>
      {active && (
        <button className={styles.clearBtn} onClick={() => setFilter(EMPTY_FILTER)}>
          clear
        </button>
      )}
      <span className={`dim ${styles.hint}`}>applies to Dashboard, Transactions & Trends</span>
      {open && (
        <FilterPanel
          committed={committed}
          onApply={(f) => { setFilter(f); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

type TagMode = 'has' | 'lacks' | null;

function FilterPanel({
  committed,
  onApply,
  onClose,
}: {
  committed: Filter;
  onApply: (f: Filter) => void;
  onClose: () => void;
}) {
  const { setPreview } = useFilter();
  const [opts, setOpts] = useState<FilterOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [selAccts, setSelAccts] = useState<Set<string>>(new Set());
  const [selOwners, setSelOwners] = useState<Set<string>>(new Set());
  const [tagModes, setTagModes] = useState<Map<string, TagMode>>(new Map());

  // Load universes via getFilterOptions (same source as the TUI panel), then
  // hydrate drafts: an absent dimension means "everything selected" (no
  // constraint) per core/filters.ts semantics. We hydrate from `committed`,
  // not the live `filter` (== preview ?? committed) — reading the live value
  // would re-seed the draft from the panel's own preview, a feedback loop.
  useEffect(() => {
    void api.queries.getFilterOptions().then((o) => {
      setOpts(o);
      setSelCats(selectionFromDim(committed.categories, o.categories));
      setSelAccts(selectionFromDim(committed.accounts, o.accounts.map((a) => a.id)));
      setSelOwners(selectionFromDim(committed.owners, o.owners));
      setTagModes(new Map((committed.tags ?? []).map((t: TagPredicate) => [t.name, t.mode])));
    }).catch((e: unknown) => {
      setLoadError(e instanceof Error ? e.message : String(e));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serialized draft, recomputed as the user adjusts selections. Published as
  // a live preview below, and committed verbatim by apply() on Apply.
  const draftFilter = useMemo<Filter | null>(() => {
    if (!opts) return null;
    const tags: TagPredicate[] = [...tagModes.entries()]
      .filter(([, mode]) => mode !== null)
      .map(([name, mode]) => ({ name, mode: mode as 'has' | 'lacks' }));
    const cats = selectionToDim(selCats, opts.categories);
    const accts = selectionToDim(selAccts, opts.accounts.map((a) => a.id));
    const owners = selectionToDim(selOwners, opts.owners);
    return {
      ...(cats !== undefined ? { categories: cats } : {}),
      ...(accts !== undefined ? { accounts: accts } : {}),
      ...(owners !== undefined ? { owners } : {}),
      ...(tags.length ? { tags } : {}),
    };
  }, [opts, selCats, selAccts, selOwners, tagModes]);

  // Publish the draft as a live preview (debounced), collapsing back to "no
  // preview" once the draft matches the committed filter so the bar reverts.
  useEffect(() => {
    if (!draftFilter) return;
    const id = setTimeout(() => {
      setPreview(filtersEqual(draftFilter, committed) ? null : draftFilter);
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draftFilter, committed, setPreview]);

  // On unmount (Apply or Cancel), force the preview back to null so screens
  // fall back to the committed filter. Distinct from the debounce cleanup
  // above: that only cancels a pending timer, which would otherwise strand a
  // previously-published (non-null) preview if we close before it fires.
  useEffect(() => () => setPreview(null), [setPreview]);

  function apply() {
    if (!opts || !draftFilter) return;
    onApply(draftFilter);
  }

  function toggle<T>(set: Set<T>, value: T, update: (s: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  }

  function section(
    title: string,
    universe: string[],
    selected: Set<string>,
    update: (s: Set<string>) => void,
    label: (v: string) => string,
  ) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h3>{title}</h3>
          <span className={styles.sectionBtns}>
            <button onClick={() => update(new Set(universe))}>all</button>
            <button onClick={() => update(new Set())}>none</button>
            <button onClick={() => update(invertSelection(selected, universe))}>invert</button>
          </span>
        </div>
        <div className={styles.checkGrid}>
          {universe.map((v) => (
            <label key={v} className={styles.check}>
              <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(selected, v, update)} />
              {label(v)}
            </label>
          ))}
        </div>
      </div>
    );
  }

  return (
    <Modal title="Filter" onClose={onClose}>
      {loadError ? (
        <p className="warn">Failed to load filter options: {loadError}</p>
      ) : !opts ? (
        <p className="dim">Loading…</p>
      ) : (
        <>
          {section('Categories', opts.categories, selCats, setSelCats, (c) => c)}
          {opts.accounts.length > 0 &&
            section('Accounts', opts.accounts.map((a) => a.id), selAccts, setSelAccts,
              (id) => opts.accounts.find((a) => a.id === id)?.name ?? id)}
          {opts.owners.length > 1 && section('Owners', opts.owners, selOwners, setSelOwners, (o) => o)}

          {opts.tags.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3>Tags</h3>
                <span className={styles.sectionBtns}>
                  <button onClick={() => setTagModes((m) => invertTagModes(new Map([...m].filter((e): e is [string, 'has' | 'lacks'] => e[1] !== null))))}>
                    invert
                  </button>
                </span>
                <span className={`dim ${styles.tagHint}`}>click to cycle: any → has → lacks</span>
              </div>
              <div className={styles.tagRow}>
                {opts.tags.map((name) => {
                  const mode = tagModes.get(name) ?? null;
                  return (
                    <button
                      key={name}
                      className={mode === 'has' ? styles.tagHas : mode === 'lacks' ? styles.tagLacks : styles.tagAny}
                      onClick={() =>
                        setTagModes((prev) => {
                          const next = new Map(prev);
                          next.set(name, mode === null ? 'has' : mode === 'has' ? 'lacks' : null);
                          return next;
                        })
                      }
                    >
                      {mode === 'has' ? '✓ ' : mode === 'lacks' ? '✗ ' : ''}
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className={styles.actions}>
            <button className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button className={styles.btnPrimary} onClick={apply}>
              Apply
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
