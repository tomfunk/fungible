import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useStatus } from '../hooks/useStatus.js';
import { useNav } from '../hooks/useNav.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { Modal } from '../components/Modal.js';
import { fmt, fmtSigned, fmtSpan, sortTags, type TagSort } from '../../../../core/fmt.js';
import type { Tag } from '../../../../core/queries.js';
import { useFilter } from '../hooks/useFilter.js';
import styles from './Tags.module.css';

export function Tags() {
  const { txFilter, navigate } = useNav();
  const { filter: sharedFilter, setFilter } = useFilter();

  // Drill-in: tag (and optionally category) write the shared filter; the
  // navigation itself carries only drillFrom so Esc reverses it as a unit.
  function drillToTransactions(tagName: string, category?: string) {
    setFilter({
      ...sharedFilter,
      tags: [{ name: tagName, mode: 'has' }],
      ...(category ? { categories: [category] } : {}),
    });
    navigate('transactions', { drillFrom: 'tags' });
  }
  const { showStatus, statusEl } = useStatus();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TagSort>('name');
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const tags = useQuery(() => api.queries.getAllTags(), [reloadKey]) ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(txFilter.focusTag ?? null);
  const [addOpen, setAddOpen] = useState(false);
  const [renameTag, setRenameTag] = useState<Tag | null>(null);

  const q = search.toLowerCase();
  const visibleTags = sortTags(
    search ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags,
    sort,
  );
  const selected = tags.find((t) => t.name.toLowerCase() === selectedName?.toLowerCase()) ?? null;

  const summary = useQuery(
    () => (selected ? api.queries.getTagSummary(selected.name) : Promise.resolve(null)),
    [selected?.name, reloadKey],
  );

  const searchRef = useRef<HTMLInputElement>(null);
  useScreenKeys({
    '/': () => searchRef.current?.focus(),
    a: () => setAddOpen(true),
    t: () => {
      if (selected) drillToTransactions(selected.name);
    },
    Escape: () => {
      if (search) setSearch('');
      else if (selected) setSelectedName(null);
      else navigate('dashboard');
    },
  });
  const maxCategorySpend = summary?.byCategory[0]?.total ?? 1;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [/] filter   [a] add tag   [t] tag's transactions   [esc] back" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Tags</h1>
        <input
          ref={searchRef}
          className={`underline ${styles.search}`}
          placeholder="Filter tags…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearch('');
              searchRef.current?.blur();
            }
          }}
        />
        <select className={styles.select} value={sort} onChange={(e) => setSort(e.target.value as TagSort)}>
          <option value="name">Sort: name</option>
          <option value="recent">Sort: most recent</option>
          <option value="oldest">Sort: oldest</option>
        </select>
        <button className={`ghostBtn ${styles.addBtn}`} onClick={() => setAddOpen(true)}>
          + New tag
        </button>
      </div>

      <div className={styles.columns}>
        <section className={styles.panel}>
          {visibleTags.length === 0 ? (
            <p className="dim">{search ? `No tags matching "${search}".` : 'No tags yet — create one, or tag transactions directly.'}</p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Tag</th>
                  <th className={styles.th}>Txns</th>
                  <th className={styles.th}>Span</th>
                </tr>
              </thead>
              <tbody>
                {visibleTags.map((t) => (
                  <tr
                    key={t.id}
                    className={selected?.id === t.id ? styles.rowActive : styles.row}
                    onClick={() => setSelectedName(t.name)}
                  >
                    <td className={styles.tdName}>{t.name}</td>
                    <td className="num dim">{t.count}</td>
                    <td className="dim">{fmtSpan(t.earliest, t.latest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={styles.panel}>
          {!selected ? (
            <p className="dim">Select a tag to see its breakdown.</p>
          ) : (
            <>
              <div className="sectionHead">
                <h2 className={styles.tagHeading}>
                  <span className="accent"># {selected.name}</span>
                </h2>
                <div className={styles.detailActions}>
                  <button className="ghostBtn" onClick={() => setRenameTag(selected)}>
                    rename
                  </button>
                  <button
                    className={`ghostBtn ${styles.dangerBtn}`}
                    onClick={async () => {
                      await api.tags.deleteTag(selected.id);
                      setSelectedName(null);
                      showStatus(`Deleted "${selected.name}"`);
                      reload();
                    }}
                  >
                    delete
                  </button>
                  <button className="ghostBtn" onClick={() => drillToTransactions(selected.name)}>
                    all transactions →
                  </button>
                </div>
              </div>
              {summary && (
                <>
                  <div className="kpiStrip">
                    <div className="kpiCell">
                      <div className="kpiLabel">Inflow</div>
                      {/* Gross, from getAllTags (selected), not summary.income:
                          getTagSummary nets refunds against spend within each
                          real category (correct for the breakdown below, but
                          it would hide a reimbursement inside Outflow here). */}
                      <div className="num pos kpiFigure">{fmt(selected.inflow)}</div>
                    </div>
                    <div className="kpiCell">
                      <div className="kpiLabel">Outflow</div>
                      <div className="num neg kpiFigure">{fmt(selected.outflow)}</div>
                    </div>
                    <div className="kpiCell">
                      <div className="kpiLabel">Net</div>
                      <div className={`num kpiFigure ${summary.net >= 0 ? 'pos' : 'neg'}`}>{fmtSigned(summary.net)}</div>
                    </div>
                    <div className="kpiCell">
                      <div className="kpiLabel">Txns</div>
                      <div className="num kpiFigure">{selected.count}</div>
                    </div>
                  </div>
                  <h3 className={`sectionLabel ${styles.blockLabel}`}>Spending by category</h3>
                  {summary.byCategory.length === 0 ? (
                    <p className="dim">No expense data for this tag.</p>
                  ) : (
                    <table className={styles.table}>
                      <tbody>
                        {summary.byCategory.map((row) => (
                          <tr
                            key={row.category}
                            className={styles.row}
                            onClick={() => drillToTransactions(selected.name, row.category)}
                          >
                            <td className={styles.tdName}>{row.category}</td>
                            <td className="num warn">{fmt(row.total)}</td>
                            <td className={styles.tdBar}>
                              <div className="barTrack">
                                <div
                                  className="barFill"
                                  style={{ width: `${Math.min(100, (row.total / maxCategorySpend) * 100)}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>

      {addOpen && (
        <NameModal
          title="New tag"
          initial=""
          onClose={() => setAddOpen(false)}
          onSave={async (name) => {
            await api.tags.createTag(name);
            setAddOpen(false);
            showStatus(`Created "${name}"`);
            reload();
          }}
        />
      )}

      {renameTag && (
        <NameModal
          title={`Rename "${renameTag.name}"`}
          initial={renameTag.name}
          onClose={() => setRenameTag(null)}
          onSave={async (name) => {
            await api.tags.renameTag(renameTag.id, name);
            if (selectedName === renameTag.name) setSelectedName(name);
            setRenameTag(null);
            showStatus('Tag renamed');
            reload();
          }}
        />
      )}

      {statusEl}
    </div>
  );
}

function NameModal({
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
        placeholder="Tag name"
        autoFocus
        className={styles.modalInput}
      />
      <div className="modalActions">
        <button className="btnSecondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btnPrimary" onClick={() => name.trim() && onSave(name.trim())} disabled={!name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
