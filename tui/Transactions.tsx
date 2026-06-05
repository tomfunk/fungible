import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  setTransactionCategory, clearTransactionOverride, setTransactionIgnored,
  setTransactionDisplayName, deleteTransaction,
  upsertCategoryRule, upsertNameRule,
  setTransactionCategoryBulk, clearOverridesBulk, setIgnoredBulk,
} from '../core/transactions.js';
import {
  getTagOptions, getTransactionTagIds, getOrCreateTag,
  addTagToTransaction, removeTagFromTransaction, addTagToTransactions,
  type TagOption,
} from '../core/tags.js';
import { applyCategoriesToAll } from '../core/categorize.js';
import { countPatternMatches } from '../core/rule-utils.js';
import { getTransactions, getAllCategories, getDataBounds, type TxRow, type SortMode } from '../core/queries.js';
import type { Screen, TxFilter } from './App.js';
import { handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { useTerminalWidth, MONTHS, C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_MANUAL, C_ACCENT, C_DIM } from './ui.js';
import { ModalPanel, usePagination, TextInput, SelectableRow, useStatusMessage, PageHeader, SearchBar, EditTextField, EditToggleField } from './components/index.js';
import { useRefreshKey } from './RefreshContext.js';
import { useSetTyping } from './TypingContext.js';

type Tx = TxRow;


type Mode = 'list' | 'search' | 'edit' | 'tag' | 'tag-all' | 'edit-all';
type EditField = 'name' | 'category' | 'pattern' | 'type';

const SORT_CYCLE: SortMode[] = ['date-desc', 'date-asc', 'name-asc', 'name-desc', 'amount-desc', 'amount-asc', 'category-asc', 'category-desc'];

const SORT_LABEL: Record<SortMode, string> = {
  'date-desc':     'date ↓', 'date-asc':      'date ↑',
  'amount-desc':   'amount ↓', 'amount-asc':  'amount ↑',
  'name-asc':      'name ↑', 'name-desc':     'name ↓',
  'category-asc':  'category ↑', 'category-desc': 'category ↓',
};

function fmt(amount: number) {
  const s = `$${Math.abs(amount).toFixed(2)}`;
  return amount < 0 ? `+${s}` : `-${s}`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}


export function Transactions({ onNavigate, initialFilter, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; initialFilter?: TxFilter; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const [category, setCategory] = useState<string | null>(initialFilter?.category ?? null);
  const [from, setFrom] = useState<string | null>(initialFilter?.from ?? null);
  const [to, setTo] = useState<string | null>(initialFilter?.to ?? null);
  const [tag, setTag] = useState<string | null>(initialFilter?.tag ?? null);
  const [account, setAccount] = useState<string | null>(initialFilter?.account ?? null);
  const [accountName, setAccountName] = useState<string | null>(initialFilter?.accountName ?? null);
  const [sort, setSort] = useState<SortMode>('date-desc');
  const [bounds, setBounds] = useState<{ minDate: string; maxDate: string }>({ minDate: '2000-01-01', maxDate: '2099-12-31' });
  const [search, setSearch] = useState(initialFilter?.search ?? '');
  const [searchInput, setSearchInput] = useState(initialFilter?.search ?? '');
  const [txs, setTxs] = useState<Tx[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const { statusMsg, showStatus } = useStatusMessage();
  const [categories, setCategories] = useState<string[]>([]);

  // Edit panel state
  const [editField, setEditField] = useState<EditField>('name');
  const [editName, setEditName] = useState('');
  const [editCatCursor, setEditCatCursor] = useState(0);
  const [editPattern, setEditPattern] = useState('');
  const [editMatchType, setEditMatchType] = useState<'name' | 'regex'>('name');

  // Tag panel state
  const [allTags, setAllTags] = useState<TagOption[]>([]);
  const [txTagIds, setTxTagIds] = useState<Set<number>>(new Set());
  const [tagCursor, setTagCursor] = useState(0);
  const [tagInput, setTagInput] = useState('');

  function load(s = search, keepCursor = false) {
    void getTransactions({ category, from, to, search: s, tag, account, sort }).then((rows) => {
      setTxs(rows);
      if (!keepCursor) setCursor(0);
      else setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
    });
  }

  useEffect(() => { void getDataBounds().then(setBounds); void getAllCategories().then(setCategories); }, []);
  useEffect(() => { load(); }, [category, from, to, search, tag, account, sort, refreshKey]);

  const setTyping = useSetTyping();
  useEffect(() => {
    const isTextInput = mode === 'search' || mode === 'tag' || mode === 'tag-all'
      || (mode === 'edit' && (editField === 'name' || editField === 'pattern'));
    setTyping(isTextInput);
  }, [mode, editField]);

  const selected = txs[cursor];

  function openEdit() {
    if (!selected) return;
    void getAllCategories().then((cats) => {
      setCategories(cats);
      setEditName('');
      setEditPattern('');
      setEditMatchType('name');
      setEditCatCursor(Math.max(0, cats.indexOf(selected.category)));
      setEditField('name');
      setMode('edit');
    });
  }

  function openTagPanel() {
    if (!selected) return;
    void Promise.all([getTagOptions(), getTransactionTagIds(selected.id)]).then(([tags, tagIds]) => {
      setAllTags(tags);
      setTxTagIds(tagIds);
      setTagInput('');
      setTagCursor(0);
      setMode('tag');
    });
  }

  function toggleTag(tagId: number) {
    if (!selected) return;
    if (txTagIds.has(tagId)) {
      removeTagFromTransaction(selected.id, tagId);
      setTxTagIds((s) => { const n = new Set(s); n.delete(tagId); return n; });
    } else {
      addTagToTransaction(selected.id, tagId);
      setTxTagIds((s) => new Set([...s, tagId]));
    }
    load(search, true);
  }

  function createAndApplyTag(name: string) {
    if (!selected) return;
    void getOrCreateTag(name).then((tagId) => {
      void addTagToTransaction(selected.id, tagId);
      void Promise.all([getTagOptions(), getTransactionTagIds(selected.id)]).then(([tags, tagIds]) => {
        setAllTags(tags);
        setTxTagIds(tagIds);
      });
      setTagInput('');
      setTagCursor(0);
      load(search, true);
    });
  }

  function saveToTransaction() {
    if (!selected) return;
    const newCat = categories[editCatCursor];
    const newDisplay = editName.trim();
    const nameChanged = newDisplay.length > 0;
    const catChanged = newCat !== selected.category;

    if (nameChanged) {
      setTransactionDisplayName(selected.id, newDisplay);
    }
    if (catChanged) {
      setTransactionCategory(selected.id, newCat);
    }

    if (nameChanged || catChanged) showStatus('Transaction updated');
    setMode('list');
    load(search, true);
  }

  async function saveAsRule() {
    if (!selected) return;
    const newCat = categories[editCatCursor];
    const newDisplay = editName.trim();
    const catChanged = newCat !== selected.category;
    const nameChanged = newDisplay.length > 0;

    const saved: string[] = [];

    if (catChanged) {
      const count = await upsertCategoryRule(editPattern, editMatchType, newCat);
      saved.push(`category rule (${count} updated)`);
    }

    if (nameChanged) {
      await upsertNameRule(editPattern, editMatchType, newDisplay);
      saved.push('name rule');
    }

    showStatus(saved.length ? `Saved: ${saved.join(' + ')}` : 'No changes', 3000);
    setMode('list');
    load(search, true);
  }

  function toggleIgnored() {
    if (!selected) return;
    setTransactionIgnored(selected.id, !selected.ignored);
    load(search, true);
  }

  function clearOverride() {
    if (!selected || !selected.manual_category) return;
    clearTransactionOverride(selected.id);
    showStatus('Override cleared');
    load(search, true);
  }

  const filteredTags = tagInput
    ? allTags.filter((t) => t.name.toLowerCase().includes(tagInput.toLowerCase()))
    : allTags;

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.escape) { setSearchInput(''); setSearch(''); setMode('list'); return; }
      if (key.return) { setSearch(searchInput); setMode('list'); return; }
      if (key.backspace || key.delete) {
        const next = searchInput.slice(0, -1);
        setSearchInput(next); setSearch(next); return;
      }
      if (input && !key.ctrl && !key.meta) {
        const next = searchInput + input;
        setSearchInput(next); setSearch(next);
      }
      return;
    }

    if (mode === 'tag') {
      if (key.escape) { setMode('list'); load(search, true); return; }
      if (key.upArrow) { setTagCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setTagCursor((c) => Math.min(filteredTags.length - 1, c + 1)); return; }
      if (input === ' ' || key.return) {
        const t = filteredTags[tagCursor];
        if (t) {
          toggleTag(t.id);
        } else if (tagInput.trim() && key.return) {
          createAndApplyTag(tagInput.trim());
        }
        return;
      }
      if (key.backspace || key.delete) { setTagInput((t) => t.slice(0, -1)); setTagCursor(0); return; }
      if (input && !key.ctrl && !key.meta) { setTagInput((t) => t + input); setTagCursor(0); return; }
      return;
    }

    if (mode === 'tag-all') {
      if (key.escape) { setMode('list'); return; }
      if (key.upArrow) { setTagCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setTagCursor((c) => Math.min(filteredTags.length - 1, c + 1)); return; }
      if (key.return) {
        const t = filteredTags[tagCursor];
        const applyTag = (tagId: number) => {
          void addTagToTransactions(txs.map((tx) => tx.id), tagId);
          showStatus(`Tagged ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`, 2500);
          setMode('list');
          load(search, true);
        };
        if (t) {
          applyTag(t.id);
        } else if (tagInput.trim()) {
          void getOrCreateTag(tagInput.trim()).then(applyTag);
        }
        return;
      }
      if (key.backspace || key.delete) { setTagInput((t) => t.slice(0, -1)); setTagCursor(0); return; }
      if (input && !key.ctrl && !key.meta) { setTagInput((t) => t + input); setTagCursor(0); return; }
      return;
    }

    if (mode === 'edit-all') {
      if (key.escape) { setMode('list'); return; }
      if (key.upArrow) { setEditCatCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setEditCatCursor((c) => Math.min(categories.length - 1, c + 1)); return; }
      if (key.return) {
        const newCat = categories[editCatCursor];
        if (newCat) {
          setTransactionCategoryBulk(txs.map((t) => t.id), newCat);
          showStatus(`Set category to "${newCat}" for ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`, 3000);
          setMode('list');
          load(search, true);
        }
        return;
      }
      return;
    }

    if (mode === 'edit') {
      const EDIT_FIELDS: EditField[] = ['name', 'category', 'pattern', 'type'];
      if (key.escape) { setMode('list'); return; }
      if (key.return) {
        if (editPattern.trim()) { void saveAsRule(); } else { saveToTransaction(); }
        return;
      }
      if (key.upArrow) { setEditField((f) => EDIT_FIELDS[Math.max(0, EDIT_FIELDS.indexOf(f) - 1)]); return; }
      if (key.downArrow) { setEditField((f) => EDIT_FIELDS[Math.min(EDIT_FIELDS.length - 1, EDIT_FIELDS.indexOf(f) + 1)]); return; }
      if (editField === 'name') {
        if (key.backspace || key.delete) { setEditName((n) => n.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setEditName((n) => n + input); return; }
      } else if (editField === 'category') {
        if (key.leftArrow) { setEditCatCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setEditCatCursor((c) => Math.min(categories.length - 1, c + 1)); return; }
      } else if (editField === 'pattern') {
        if (key.backspace || key.delete) { setEditPattern((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setEditPattern((p) => p + input); return; }
      } else if (editField === 'type') {
        if (key.leftArrow || key.rightArrow) { setEditMatchType((t) => t === 'name' ? 'regex' : 'name'); return; }
      }
      return;
    }

    if (mode === 'list') {
      if (input === 's') { setSort((s) => SORT_CYCLE[(SORT_CYCLE.indexOf(s) + 1) % SORT_CYCLE.length]); return; }
      // Pass active search to adjacent screens (1=dashboard, 3=trends)
      if (input === '1') { onNavigate('dashboard', search ? { search } : undefined); return; }
      if (input === '3') { onNavigate('trends', search ? { search } : undefined); return; }
      if (handleNavKey(input, 'transactions', onNavigate)) return;
      if (key.escape) {
        if (search) { setSearch(''); setSearchInput(''); return; }
        if (from) { setFrom(null); setTo(null); return; }
        if (tag) { setTag(null); return; }
        if (account) { setAccount(null); setAccountName(null); return; }
        onNavigate('dashboard', search ? { search } : undefined);
        return;
      }
      if (key.leftArrow && from) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const y = parseInt(from.slice(0, 4)); const m = parseInt(from.slice(5, 7));
        const prevM = m === 1 ? 12 : m - 1; const prevY = m === 1 ? y - 1 : y;
        const newFrom = `${prevY}-${pad(prevM)}-01`;
        if (newFrom >= bounds.minDate) { setFrom(newFrom); setTo(`${prevY}-${pad(prevM)}-31`); }
        return;
      }
      if (key.rightArrow && from) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const y = parseInt(from.slice(0, 4)); const m = parseInt(from.slice(5, 7));
        const nextM = m === 12 ? 1 : m + 1; const nextY = m === 12 ? y + 1 : y;
        const newFrom = `${nextY}-${pad(nextM)}-01`;
        if (newFrom <= bounds.maxDate) { setFrom(newFrom); setTo(`${nextY}-${pad(nextM)}-31`); }
        return;
      }
      if (input === '/') { setMode('search'); return; }
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(txs.length - 1, c + 1));
      if (input === 'u') { setSearch(''); setSearchInput(''); setCategory('Uncategorized'); setFrom(null); setTo(null); setTag(null); setAccount(null); setAccountName(null); }
      if (input === 'a') { setSearch(''); setSearchInput(''); setCategory(null); setFrom(null); setTo(null); setTag(null); setAccount(null); setAccountName(null); }
      if (key.return && selected) openEdit();
      if (input === 'E' && txs.length > 0) {
        void getAllCategories().then((cats) => {
          setCategories(cats);
          setEditCatCursor(0);
          setMode('edit-all');
        });
        return;
      }
      if (input === 'g' && selected) openTagPanel();
      if (input === 'G' && txs.length > 0) {
        void getTagOptions().then((tags) => {
          setAllTags(tags);
          setTagInput('');
          setTagCursor(0);
          setMode('tag-all');
        });
        return;
      }
      if (input === 'c' && selected?.manual_category) clearOverride();
      if (input === 'C' && txs.length > 0) {
        clearOverridesBulk(txs.map((t) => t.id));
        const count = txs.filter((t) => t.manual_category).length;
        showStatus(`Cleared overrides on ${count} transaction${count !== 1 ? 's' : ''}`, 2500);
        load(search, true);
        return;
      }
      if (input === 'i' && selected) toggleIgnored();
      if (input === 'I' && txs.length > 0) {
        const target = !selected?.ignored;
        setIgnoredBulk(txs.map((t) => t.id), target);
        showStatus(`${target ? 'Ignored' : 'Un-ignored'} ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`, 2500);
        load(search, true);
        return;
      }
      if (input === 'x' && selected?.id.startsWith('csv-')) {
        deleteTransaction(selected.id);
        load(search);
        return;
      }
    }
  }, { isActive: isActive !== false });

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // [sel+date=12] gap [desc] gap [amount=10] gap [cat] — 3 gaps of 2
  const txFlex = Math.max(18, inner - 28);
  const descW = Math.max(10, Math.floor(txFlex * 0.55));
  const catW  = Math.max(8,  txFlex - descW);

  const PAGE = 20;
  const { visible, pageStart } = usePagination(txs, cursor, PAGE);

  function dateLabel(): string | null {
    if (!from) return null;
    const y = from.slice(0, 4); const m = parseInt(from.slice(5, 7));
    // Full month check: from is 1st, to is end of same month
    if (to && from === `${y}-${String(m).padStart(2, '0')}-01` && to.slice(0, 7) === from.slice(0, 7)) {
      return `${MONTHS[m - 1]} ${y}`;
    }
    return `${from} – ${to ?? ''}`;
  }

  const dl = dateLabel();
  const filterLabel = [
    accountName,
    tag ? `#${tag}` : null,
    search ? `"${search}"` : null,
    category,
  ].filter(Boolean).join(' · ');

  // Category list window for edit panel
  const CAT_WIN = 8;
  const catWinStart = Math.max(0, Math.min(editCatCursor - Math.floor(CAT_WIN / 2), categories.length - CAT_WIN));
  const visibleCats = categories.slice(catWinStart, catWinStart + CAT_WIN);

  // Live match count when a rule pattern is typed
  const [matchCount, setMatchCount] = useState(0);
  useEffect(() => {
    if (mode === 'edit' && editPattern.trim()) {
      void countPatternMatches(editPattern, editMatchType).then(setMatchCount);
    } else {
      setMatchCount(0);
    }
  }, [mode, editPattern, editMatchType]);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="transactions" showHints={showHints} />
      <Box marginTop={1}>
        <Text bold>
          Transactions
          {filterLabel ? <Text color={C_WARNING}>  {filterLabel}</Text> : null}
          {dl ? <Text>
            <Text color={C_WARNING}>{filterLabel ? '  · ' : '  '}</Text>
            <Text dimColor>← </Text>
            <Text color={C_WARNING}>{dl}</Text>
            <Text dimColor> →</Text>
          </Text> : null}
        </Text>
      </Box>
      <Text dimColor>
        {showHints
          ? `[/] search  ·  ${from ? '← →  ·  ' : ''}[s] sort  ·  Enter edit  [g] tag  [i] ignore  [x] delete`
          : '[/] search'}
      </Text>

      {mode === 'search' && <SearchBar value={searchInput} />}
      <Box marginTop={1}><Divider /></Box>

      <Box marginTop={1}>
        <Text>{'  '}</Text>
        <Box gap={2}>
          <Text color={sort.startsWith('date') ? C_ACCENT : undefined} dimColor={!sort.startsWith('date')}>
            {('DATE' + (sort === 'date-desc' ? ' ↓' : sort === 'date-asc' ? ' ↑' : '  ')).padEnd(10)}
          </Text>
          <Text color={sort.startsWith('name') ? C_ACCENT : undefined} dimColor={!sort.startsWith('name')}>
            {('DESCRIPTION' + (sort === 'name-asc' ? ' ↑' : sort === 'name-desc' ? ' ↓' : '  ')).padEnd(descW)}
          </Text>
          <Text color={sort.startsWith('amount') ? C_ACCENT : undefined} dimColor={!sort.startsWith('amount')}>
            {('AMOUNT' + (sort === 'amount-desc' ? ' ↓' : sort === 'amount-asc' ? ' ↑' : '  ')).padStart(10)}
          </Text>
          <Text color={sort.startsWith('category') ? C_ACCENT : undefined} dimColor={!sort.startsWith('category')}>
            {'CATEGORY' + (sort === 'category-asc' ? ' ↑' : sort === 'category-desc' ? ' ↓' : '')}
          </Text>
        </Box>
      </Box>

      {visible.map((tx) => {
        const isSelected = tx.id === selected?.id;
        const isPinned = !!tx.manual_category;
        const isIgnored = !!tx.ignored;
        const hasTags = !!tx.tag_names;
        return (
          <Box key={tx.id} flexDirection="column">
            <SelectableRow selected={isSelected}>
              <Text color={isSelected ? C_ACCENT : undefined} dimColor={isIgnored && !isSelected}>
                {tx.date}
              </Text>
              <Text dimColor={isIgnored}>{truncate(tx.display_name ?? tx.name, descW).padEnd(descW)}</Text>
              <Text color={isIgnored ? undefined : tx.amount < 0 ? C_POSITIVE : undefined} dimColor={isIgnored}>
                {fmt(tx.amount).padStart(10)}
              </Text>
              <Text
                color={isIgnored ? undefined : tx.category === 'Uncategorized' ? C_WARNING : isPinned ? C_MANUAL : undefined}
                dimColor={isIgnored || !isSelected}
              >
                {truncate((isPinned ? '◆ ' : '  ') + (isIgnored ? '~' : '') + tx.category, catW).padEnd(catW)}
              </Text>
            </SelectableRow>
            {hasTags && isSelected && (
              <Box paddingLeft={14}>
                <Text color={C_ACCENT}>{truncate('# ' + tx.tag_names, inner - 14)}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Divider />
      <Text dimColor>{txs.length} transactions{txs.length === 200 ? ' (limit 200)' : ''}</Text>
      {statusMsg && <Text color={C_POSITIVE}>{statusMsg}</Text>}

      {mode === 'tag' && selected && (
        <ModalPanel borderColor={C_WARNING}>
          <Text bold>Tags  <Text dimColor>{selected.display_name ?? selected.name}</Text></Text>
          <Box marginTop={1} gap={2}>
            <Text dimColor>Filter/new: </Text>
            <TextInput value={tagInput} color={C_WARNING} />
          </Box>
          {filteredTags.length === 0 && tagInput ? (
            <Box marginTop={1}><Text dimColor>Enter to create "{tagInput}"</Text></Box>
          ) : (
            filteredTags.map((t, i) => {
              const isSelected = i === tagCursor;
              const has = txTagIds.has(t.id);
              return (
                <SelectableRow key={t.id} selected={isSelected}>
                  <Text color={has ? C_POSITIVE : undefined} dimColor={!isSelected && !has}>
                    {has ? '● ' : '○ '}{t.name}
                  </Text>
                </SelectableRow>
              );
            })
          )}
          {allTags.length === 0 && !tagInput && (
            <Box marginTop={1}><Text dimColor>No tags yet — type a name and Enter to create one</Text></Box>
          )}
          <Box marginTop={1}><Text dimColor>Space/Enter toggle  ·  Esc close</Text></Box>
        </ModalPanel>
      )}

      {mode === 'tag-all' && (
        <ModalPanel>
          <Text bold>Tag all <Text color={C_ACCENT}>{txs.length}</Text> visible transactions</Text>
          <Box marginTop={1} gap={2}>
            <Text dimColor>Tag: </Text>
            <TextInput value={tagInput} />
          </Box>
          {filteredTags.length === 0 && tagInput ? (
            <Box marginTop={1}><Text dimColor>Enter to create & apply "{tagInput}"</Text></Box>
          ) : (
            filteredTags.map((t, i) => {
              const isSel = i === tagCursor;
              return (
                <SelectableRow key={t.id} selected={isSel}>
                  <Text dimColor={!isSel}>{t.name}</Text>
                </SelectableRow>
              );
            })
          )}
          <Box marginTop={1}><Text dimColor>↑↓ select  ·  Enter apply  ·  Esc cancel</Text></Box>
        </ModalPanel>
      )}

      {mode === 'edit-all' && (
        <ModalPanel borderColor={C_MANUAL}>
          <Text bold>Set category for all <Text color={C_ACCENT}>{txs.length}</Text> visible transactions</Text>
          <Text dimColor>↑↓ select  ·  Enter apply  ·  Esc cancel</Text>
          <Box flexDirection="column" marginTop={1}>
            {visibleCats.map((cat, i) => {
              const idx = catWinStart + i;
              const isSel = idx === editCatCursor;
              return (
                <SelectableRow key={cat} selected={isSel}>
                  <Text color={isSel ? C_ACCENT : undefined} dimColor={!isSel}>{cat}</Text>
                </SelectableRow>
              );
            })}
          </Box>
        </ModalPanel>
      )}

      {mode === 'edit' && selected && (
        <ModalPanel borderColor={editPattern.trim() ? C_MANUAL : undefined}>
          <Text bold>Edit  <Text dimColor>{selected.name}</Text></Text>

          <Box marginTop={1} flexDirection="column" gap={1}>
            <EditTextField label="Name" labelWidth={12} active={editField === 'name'} value={editName} color={C_WARNING} placeholder="type new name…" emptyText="(unchanged)" />
            <EditToggleField label="Category" labelWidth={12} active={editField === 'category'} value={categories[editCatCursor] ?? '—'} />
            <EditTextField label="Pattern" labelWidth={12} active={editField === 'pattern'} value={editPattern} color={C_MANUAL} placeholder="optional — saves as rule" emptyText="—" />
            <EditToggleField label="Match type" labelWidth={12} active={editField === 'type'} value={editMatchType} />
          </Box>

          {editPattern.trim() ? (
            <Box marginTop={1} gap={2}>
              <Text color={C_WARNING}>{matchCount} transactions match</Text>
              <Text dimColor>· Enter saves as rule</Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text>
          </Box>
        </ModalPanel>
      )}
    </Box>
  );
}
