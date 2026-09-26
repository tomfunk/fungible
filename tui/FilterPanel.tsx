import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { getFilterOptions, type FilterOptions } from '../core/queries.js';
import { useFilter } from './FilterContext.js';
import {
  selectionToDim, selectionFromDim, invertSelection, invertTagModes, filtersEqual,
  type Filter, type TagPredicate,
} from '../core/filters.js';
import { ModalPanel, usePagination } from './components/index.js';
import { C_ACCENT, C_POSITIVE, C_NEGATIVE, C_DIM } from './ui.js';

// Global, session-wide filter panel. Opens over any screen; reads the current
// shared filter into a draft, lets you adjust all four dimensions, and writes it
// back via setFilter on apply. Categories/accounts/owners use a select-from-
// universe model (everything selected → no constraint); tags are tri-state
// (off / has / lacks) matching the TagPredicate model. The dimensions render as
// horizontal tabs (←/→ to switch) so every section is discoverable at a glance.

type Section = 'categories' | 'accounts' | 'owners' | 'tags';
const SECTIONS: Section[] = ['categories', 'accounts', 'owners', 'tags'];
const SECTION_LABEL: Record<Section, string> = {
  categories: 'Categories', accounts: 'Accounts', owners: 'Owners', tags: 'Tags',
};

type Item = { key: string; label: string; sub?: string };

const WINDOW = 16;
// Debounce window for publishing the live preview. Bulk ops (a/n/i) mutate the
// draft several times within a single tick; coalescing them past this delay
// collapses the burst into one query round-trip instead of one per keystroke.
const PREVIEW_DEBOUNCE_MS = 120;

export function FilterPanel({ isActive, onClose }: { isActive: boolean; onClose: () => void }) {
  const { committed, setFilter, setPreview } = useFilter();
  const [opts, setOpts] = useState<FilterOptions | null>(null);

  // Draft selection state. Sets hold the *selected* members of each universe;
  // tagModes maps a tag name to its predicate ('has'/'lacks'), absent = off.
  const [catSel, setCatSel] = useState<Set<string>>(new Set());
  const [acctSel, setAcctSel] = useState<Set<string>>(new Set());
  const [ownerSel, setOwnerSel] = useState<Set<string>>(new Set());
  const [tagModes, setTagModes] = useState<Map<string, 'has' | 'lacks'>>(new Map());
  const [section, setSection] = useState(0);
  // Per-section cursors, kept while the panel is open so flipping between tabs
  // doesn't lose your place in a long list.
  const [cursors, setCursors] = useState<Record<Section, number>>({
    categories: 0, accounts: 0, owners: 0, tags: 0,
  });

  // Load options + hydrate the draft on open. We hydrate from `committed`, not
  // from `filter` (== preview ?? committed): the panel is the thing publishing
  // the preview, so reading `filter` here would re-seed the draft from our own
  // preview — a feedback loop. `committed` is the stable source of truth.
  useEffect(() => {
    void getFilterOptions().then((o) => {
      setOpts(o);
      setCatSel(selectionFromDim(committed.categories, o.categories));
      setAcctSel(selectionFromDim(committed.accounts, o.accounts.map((a) => a.id)));
      setOwnerSel(selectionFromDim(committed.owners, o.owners));
      setTagModes(new Map((committed.tags ?? []).map((t) => [t.name, t.mode])));
      setSection(0);
      setCursors({ categories: 0, accounts: 0, owners: 0, tags: 0 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentSection = SECTIONS[section];

  function itemsForSection(s: Section): Item[] {
    if (!opts) return [];
    if (s === 'categories') return opts.categories.map((c) => ({ key: c, label: c }));
    if (s === 'accounts') return opts.accounts.map((a) => ({ key: a.id, label: a.name, sub: a.owner }));
    if (s === 'owners') return opts.owners.map((o) => ({ key: o, label: o }));
    return opts.tags.map((t) => ({ key: t, label: t }));
  }
  const items = itemsForSection(currentSection);
  const cursor = Math.min(cursors[currentSection], Math.max(0, items.length - 1));
  const current: Item | undefined = items[cursor];

  function selForSection(s: Section): [Set<string>, (next: Set<string>) => void] {
    if (s === 'categories') return [catSel, setCatSel];
    if (s === 'accounts') return [acctSel, setAcctSel];
    return [ownerSel, setOwnerSel];
  }
  function universeForSection(s: Section): string[] {
    if (!opts) return [];
    if (s === 'categories') return opts.categories;
    if (s === 'accounts') return opts.accounts.map((a) => a.id);
    return opts.owners;
  }

  function moveCursor(delta: number) {
    setCursors((c) => ({
      ...c,
      [currentSection]: Math.max(0, Math.min(items.length - 1, c[currentSection] + delta)),
    }));
  }

  function toggleCurrent() {
    if (!current) return;
    if (currentSection === 'tags') {
      setTagModes((m) => {
        const n = new Map(m);
        const cur = n.get(current.key);
        if (cur === undefined) n.set(current.key, 'has');
        else if (cur === 'has') n.set(current.key, 'lacks');
        else n.delete(current.key);
        return n;
      });
      return;
    }
    const [sel, set] = selForSection(currentSection);
    const n = new Set(sel);
    if (n.has(current.key)) n.delete(current.key); else n.add(current.key);
    set(n);
  }

  function bulk(all: boolean) {
    if (currentSection === 'tags') {
      if (!all) setTagModes(new Map());
      return;
    }
    const [, set] = selForSection(currentSection);
    set(all ? new Set(universeForSection(currentSection)) : new Set());
  }

  function invert() {
    if (currentSection === 'tags') {
      setTagModes((m) => invertTagModes(m));
      return;
    }
    const [sel, set] = selForSection(currentSection);
    set(invertSelection(sel, universeForSection(currentSection)));
  }

  function clearAll() {
    if (!opts) return;
    setCatSel(new Set(opts.categories));
    setAcctSel(new Set(opts.accounts.map((a) => a.id)));
    setOwnerSel(new Set(opts.owners));
    setTagModes(new Map());
  }

  // Serialized draft, recomputed as the user adjusts selections. Published as
  // a live preview below, and committed verbatim by apply() on Enter.
  const draftFilter = useMemo<Filter | null>(() => {
    if (!opts) return null;
    const tags: TagPredicate[] = [...tagModes.entries()].map(([name, mode]) => ({ name, mode }));
    const next: Filter = {};
    const cats = selectionToDim(catSel, opts.categories);
    const accts = selectionToDim(acctSel, opts.accounts.map((a) => a.id));
    const owners = selectionToDim(ownerSel, opts.owners);
    if (cats !== undefined) next.categories = cats;
    if (accts !== undefined) next.accounts = accts;
    if (owners !== undefined) next.owners = owners;
    if (tags.length) next.tags = tags;
    return next;
  }, [opts, catSel, acctSel, ownerSel, tagModes]);

  // Publish the draft as a live preview (debounced), collapsing back to "no
  // preview" once the draft matches the committed filter. `committed` is a dep
  // but cannot change while the panel is open — the modal gates host input, so
  // nothing can call setFilter/popFilter underneath us.
  useEffect(() => {
    if (!draftFilter) return;
    const id = setTimeout(() => {
      setPreview(filtersEqual(draftFilter, committed) ? null : draftFilter);
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draftFilter, committed, setPreview]);

  // On unmount (Esc or Enter), force the preview back to null so screens fall
  // back to the committed filter. This is distinct from the debounce cleanup
  // above: that only cancels a pending timer, which would otherwise strand a
  // previously-published (non-null) preview if we close before it fires.
  useEffect(() => () => setPreview(null), [setPreview]);

  function apply() {
    if (!opts || !draftFilter) { onClose(); return; }
    setFilter(draftFilter);
    onClose();
  }

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.return) { apply(); return; }
    if (key.leftArrow) { setSection((s) => (s + SECTIONS.length - 1) % SECTIONS.length); return; }
    if (key.rightArrow) { setSection((s) => (s + 1) % SECTIONS.length); return; }
    if (key.upArrow) { moveCursor(-1); return; }
    if (key.downArrow) { moveCursor(1); return; }
    if (input === ' ') { toggleCurrent(); return; }
    const k = input.toLowerCase();
    if (k === 'a') { bulk(true); return; }
    if (k === 'n') { bulk(false); return; }
    if (k === 'i') { invert(); return; }
    if (input === 'c') { clearAll(); return; }
  }, { isActive });

  if (!opts) return null;

  // Window the focused section's list around the cursor so a long universe
  // stays bounded.
  const { visible, pageStart: winStart } = usePagination(items, cursor, WINDOW);
  const clippedAbove = winStart;
  const clippedBelow = items.length - (winStart + visible.length);

  function sectionCount(s: Section): string {
    if (s === 'tags') {
      const n = [...tagModes.values()].length;
      return n ? ` (${n})` : '';
    }
    const [sel] = selForSection(s);
    const total = universeForSection(s).length;
    return sel.size === total ? ' (all)' : ` (${sel.size}/${total})`;
  }

  return (
    <ModalPanel title="Filter" borderColor={C_ACCENT}>
      <Text dimColor>
        ←→ section  ·  ↑↓ move  ·  Space toggle  ·  a all  ·  n none  ·  i invert  ·  c clear  ·  Enter apply  ·  Esc cancel
      </Text>
      <Box marginTop={1} gap={3}>
        {SECTIONS.map((s) => (
          <Text
            key={s}
            bold={s === currentSection}
            color={s === currentSection ? C_ACCENT : undefined}
            dimColor={s !== currentSection}
          >
            {s === currentSection ? '▶ ' : '  '}{SECTION_LABEL[s]}{sectionCount(s)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>  no {SECTION_LABEL[currentSection].toLowerCase()}</Text>
        ) : null}
        {clippedAbove > 0 ? <Text color={C_DIM}>  ↑ {clippedAbove} more</Text> : null}
        {visible.map((item, i) => {
          const isCursor = winStart + i === cursor;
          let mark: React.ReactNode;
          if (currentSection === 'tags') {
            const mode = tagModes.get(item.key);
            mark = mode === 'has'
              ? <Text color={C_POSITIVE}>✓ has  </Text>
              : mode === 'lacks'
                ? <Text color={C_NEGATIVE}>✗ lacks</Text>
                : <Text dimColor>○ off  </Text>;
          } else {
            const [sel] = selForSection(currentSection);
            mark = sel.has(item.key)
              ? <Text color={C_POSITIVE}>●</Text>
              : <Text dimColor>○</Text>;
          }
          return (
            <Box key={`${currentSection}-${item.key}`}>
              <Text color={isCursor ? C_ACCENT : undefined}>{isCursor ? '▶ ' : '  '}</Text>
              <Box gap={1}>
                {mark}
                <Text color={isCursor ? C_ACCENT : undefined} dimColor={!isCursor}>{item.label}</Text>
                {item.sub ? <Text color={C_DIM}>{item.sub}</Text> : null}
              </Box>
            </Box>
          );
        })}
        {clippedBelow > 0 ? <Text color={C_DIM}>  ↓ {clippedBelow} more</Text> : null}
      </Box>
    </ModalPanel>
  );
}
