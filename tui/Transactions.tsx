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
import { NavHints, handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { useTerminalWidth, CURSOR, MONTHS, C_POSITIVE, C_NEGATIVE, C_WARNING, C_NEUTRAL, C_MANUAL, C_ACCENT, C_DIM } from './ui.js';
import { useSetTyping } from './TypingContext.js';

type Tx = TxRow;


type Mode = 'list' | 'search' | 'edit' | 'edit-rule' | 'tag' | 'tag-all' | 'edit-all';
type EditField = 'name' | 'category';

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
  const [category, setCategory] = useState<string | null>(initialFilter?.category ?? null);
  const [from, setFrom] = useState<string | null>(initialFilter?.from ?? null);
  const [to, setTo] = useState<string | null>(initialFilter?.to ?? null);
  const [tag, setTag] = useState<string | null>(initialFilter?.tag ?? null);
  const [account, setAccount] = useState<string | null>(initialFilter?.account ?? null);
  const [accountName, setAccountName] = useState<string | null>(initialFilter?.accountName ?? null);
  const [sort, setSort] = useState<SortMode>('date-desc');
  const [bounds] = useState(getDataBounds);
  const [search, setSearch] = useState(initialFilter?.search ?? '');
  const [searchInput, setSearchInput] = useState(initialFilter?.search ?? '');
  const [txs, setTxs] = useState<Tx[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [statusMsg, setStatusMsg] = useState('');
  const [categories, setCategories] = useState<string[]>(getAllCategories);

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
    const rows = getTransactions({ category, from, to, search: s, tag, account, sort });
    setTxs(rows);
    if (!keepCursor) setCursor(0);
    else setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }

  useEffect(() => { load(); }, [category, from, to, search, tag, account, sort]);

  const setTyping = useSetTyping();
  useEffect(() => {
    const isTextInput = mode === 'search' || mode === 'edit-rule' || mode === 'tag' || mode === 'tag-all'
      || (mode === 'edit' && editField === 'name');
    setTyping(isTextInput);
  }, [mode, editField]);

  const selected = txs[cursor];

  function openEdit() {
    if (!selected) return;
    const cats = getAllCategories();
    setCategories(cats);
    setEditName('');
    setEditCatCursor(Math.max(0, cats.indexOf(selected.category)));
    setEditField('name');
    setMode('edit');
  }

  function openTagPanel() {
    if (!selected) return;
    setAllTags(getTagOptions());
    setTxTagIds(getTransactionTagIds(selected.id));
    setTagInput('');
    setTagCursor(0);
    setMode('tag');
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
    const tagId = getOrCreateTag(name);
    addTagToTransaction(selected.id, tagId);
    setAllTags(getTagOptions());
    setTxTagIds((s) => new Set([...s, tagId]));
    setTagInput('');
    setTagCursor(0);
    load(search, true);
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

    if (nameChanged || catChanged) setStatusMsg('Transaction updated');
    setMode('list');
    setTimeout(() => setStatusMsg(''), 2000);
    load(search, true);
  }

  function saveAsRule() {
    if (!selected) return;
    const newCat = categories[editCatCursor];
    const newDisplay = editName.trim();
    const catChanged = newCat !== selected.category;
    const nameChanged = newDisplay.length > 0;

    const saved: string[] = [];

    if (catChanged) {
      const count = upsertCategoryRule(editPattern, editMatchType, newCat);
      saved.push(`category rule (${count} updated)`);
    }

    if (nameChanged) {
      upsertNameRule(editPattern, editMatchType, newDisplay);
      saved.push('name rule');
    }

    setStatusMsg(saved.length ? `Saved: ${saved.join(' + ')}` : 'No changes');
    setMode('list');
    setTimeout(() => setStatusMsg(''), 3000);
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
    setStatusMsg('Override cleared');
    setTimeout(() => setStatusMsg(''), 2000);
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
        let tagId: number | null = null;
        if (t) {
          tagId = t.id;
        } else if (tagInput.trim()) {
          tagId = getOrCreateTag(tagInput.trim());
        }
        if (tagId !== null) {
          addTagToTransactions(txs.map((tx) => tx.id), tagId);
          setStatusMsg(`Tagged ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`);
          setTimeout(() => setStatusMsg(''), 2500);
          setMode('list');
          load(search, true);
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
          setStatusMsg(`Set category to "${newCat}" for ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`);
          setTimeout(() => setStatusMsg(''), 3000);
          setMode('list');
          load(search, true);
        }
        return;
      }
      return;
    }

    if (mode === 'edit') {
      if (key.escape) { setMode('list'); return; }
      if (editField === 'name') {
        if (key.return || key.rightArrow) { setEditField('category'); return; }
        if (key.leftArrow) { return; }
        if (key.backspace || key.delete) { setEditName((n) => n.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setEditName((n) => n + input); return; }
      } else {
        if (key.leftArrow) { setEditField('name'); return; }
        if (key.upArrow) { setEditCatCursor((c) => Math.max(0, c - 1)); return; }
        if (key.downArrow) { setEditCatCursor((c) => Math.min(categories.length - 1, c + 1)); return; }
        if (input === 't' || key.return) { saveToTransaction(); return; }
        if (input === 'r') {
          setEditPattern(selected?.name ?? '');
          setEditMatchType('name');
          setMode('edit-rule');
          return;
        }
      }
      return;
    }

    if (mode === 'edit-rule') {
      if (key.escape) { setMode('edit'); return; }
      if (input === 'n') { setEditMatchType('name'); return; }
      if (input === 'x') { setEditMatchType('regex'); return; }
      if (key.return) { saveAsRule(); return; }
      if (key.backspace || key.delete) { setEditPattern((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setEditPattern((p) => p + input); return; }
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
      if (input === 'e' && selected) openEdit();
      if (input === 'E' && txs.length > 0) {
        const cats = getAllCategories();
        setCategories(cats);
        setEditCatCursor(0);
        setMode('edit-all');
        return;
      }
      if (input === 'g' && selected) openTagPanel();
      if (input === 'G' && txs.length > 0) {
        setAllTags(getTagOptions());
        setTagInput('');
        setTagCursor(0);
        setMode('tag-all');
        return;
      }
      if (input === 'c' && selected?.manual_category) clearOverride();
      if (input === 'C' && txs.length > 0) {
        clearOverridesBulk(txs.map((t) => t.id));
        const count = txs.filter((t) => t.manual_category).length;
        setStatusMsg(`Cleared overrides on ${count} transaction${count !== 1 ? 's' : ''}`);
        setTimeout(() => setStatusMsg(''), 2500);
        load(search, true);
        return;
      }
      if (input === 'i' && selected) toggleIgnored();
      if (input === 'I' && txs.length > 0) {
        const target = !selected?.ignored;
        setIgnoredBulk(txs.map((t) => t.id), target);
        setStatusMsg(`${target ? 'Ignored' : 'Un-ignored'} ${txs.length} transaction${txs.length !== 1 ? 's' : ''}`);
        setTimeout(() => setStatusMsg(''), 2500);
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
  const pageStart = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), txs.length - PAGE));
  const visible = txs.slice(pageStart, pageStart + PAGE);

  function dateLabel(): string | null {
    if (!from) return null;
    const y = from.slice(0, 4); const m = parseInt(from.slice(5, 7));
    // Full month check: from is 1st, to is end of same month
    if (to && from === `${y}-${String(m).padStart(2, '0')}-01` && to.slice(0, 7) === from.slice(0, 7)) {
      return `${MONTHS[m - 1]} ${y}`;
    }
    return `${from} – ${to ?? ''}`;
  }

  const filterLabel = [
    accountName,
    tag ? `#${tag}` : null,
    search ? `"${search}"` : null,
    category,
    dateLabel(),
  ].filter(Boolean).join(' · ');

  // Category list window for edit panel
  const CAT_WIN = 8;
  const catWinStart = Math.max(0, Math.min(editCatCursor - Math.floor(CAT_WIN / 2), categories.length - CAT_WIN));
  const visibleCats = categories.slice(catWinStart, catWinStart + CAT_WIN);

  // Live match count for rule panel
  const matchCount = mode === 'edit-rule' ? countPatternMatches(editPattern, editMatchType) : 0;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color={C_ACCENT}>fungible</Text>
        <NavHints current="transactions" showHints={showHints} />
      </Box>
      <Box marginTop={1}>
        <Text bold>
          Transactions
          {filterLabel ? <Text color={C_WARNING}>  {filterLabel}</Text> : null}
        </Text>
      </Box>
      {showHints && <Box justifyContent="flex-end">
        <Text dimColor>
          {from ? '← →  ·  ' : ''}[s] sort  ·  [/] search  ·  [e] edit  [g] tag  [i] ignore  [x] delete
        </Text>
      </Box>}

      {mode === 'search' && (
        <Box marginTop={1}>
          <Text color={C_ACCENT}>/</Text>
          <Text>{searchInput}</Text>
          <Text color={C_ACCENT}>{CURSOR}</Text>
          <Text dimColor>  Esc cancel</Text>
        </Box>
      )}
      <Box marginTop={1}><Divider /></Box>

      <Box gap={2} marginTop={1}>
        <Text color={sort.startsWith('date') ? C_ACCENT : undefined} dimColor={!sort.startsWith('date')}>
          {'  DATE ' + (sort === 'date-desc' ? '↓' : sort === 'date-asc' ? '↑' : ' ') + '   '}
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

      {visible.map((tx) => {
        const isSelected = tx.id === selected?.id;
        const isPinned = !!tx.manual_category;
        const isIgnored = !!tx.ignored;
        const hasTags = !!tx.tag_names;
        return (
          <Box key={tx.id} flexDirection="column">
            <Box gap={2}>
              <Text color={isSelected ? C_ACCENT : undefined} dimColor={isIgnored && !isSelected}>
                {isSelected ? '▶ ' : '  '}{tx.date}
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
            </Box>
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
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_WARNING} paddingX={2} paddingY={1}>
          <Text bold>Tags  <Text dimColor>{selected.display_name ?? selected.name}</Text></Text>
          <Box marginTop={1} gap={2}>
            <Text dimColor>Filter/new: </Text>
            <Text color={C_WARNING}>{tagInput}</Text>
            <Text color={C_WARNING}>█</Text>
          </Box>
          {filteredTags.length === 0 && tagInput ? (
            <Box marginTop={1}><Text dimColor>Enter to create "{tagInput}"</Text></Box>
          ) : (
            filteredTags.map((t, i) => {
              const isSelected = i === tagCursor;
              const has = txTagIds.has(t.id);
              return (
                <Box key={t.id}>
                  <Text color={isSelected ? C_ACCENT : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                  <Text color={has ? C_POSITIVE : undefined} dimColor={!isSelected && !has}>
                    {has ? '● ' : '○ '}{t.name}
                  </Text>
                </Box>
              );
            })
          )}
          {allTags.length === 0 && !tagInput && (
            <Box marginTop={1}><Text dimColor>No tags yet — type a name and Enter to create one</Text></Box>
          )}
          <Box marginTop={1}><Text dimColor>Space/Enter toggle  ·  Esc close</Text></Box>
        </Box>
      )}

      {mode === 'tag-all' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>Tag all <Text color={C_ACCENT}>{txs.length}</Text> visible transactions</Text>
          <Box marginTop={1} gap={2}>
            <Text dimColor>Tag: </Text>
            <Text color={C_WARNING}>{tagInput}</Text>
            <Text color={C_ACCENT}>{CURSOR}</Text>
          </Box>
          {filteredTags.length === 0 && tagInput ? (
            <Box marginTop={1}><Text dimColor>Enter to create & apply "{tagInput}"</Text></Box>
          ) : (
            filteredTags.map((t, i) => {
              const isSel = i === tagCursor;
              return (
                <Box key={t.id}>
                  <Text color={isSel ? C_ACCENT : undefined}>{isSel ? '▶ ' : '  '}</Text>
                  <Text dimColor={!isSel}>{t.name}</Text>
                </Box>
              );
            })
          )}
          <Box marginTop={1}><Text dimColor>↑↓ select  ·  Enter apply  ·  Esc cancel</Text></Box>
        </Box>
      )}

      {mode === 'edit-all' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_MANUAL} paddingX={2} paddingY={1}>
          <Text bold>Set category for all <Text color={C_ACCENT}>{txs.length}</Text> visible transactions</Text>
          <Text dimColor>↑↓ select  ·  Enter apply  ·  Esc cancel</Text>
          <Box flexDirection="column" marginTop={1}>
            {visibleCats.map((cat, i) => {
              const idx = catWinStart + i;
              const isSel = idx === editCatCursor;
              return (
                <Text key={cat} color={isSel ? C_ACCENT : undefined} dimColor={!isSel}>
                  {isSel ? '▶ ' : '  '}{cat}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'edit' && selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>Edit  <Text dimColor>{selected.name}</Text></Text>

          <Box marginTop={1} gap={3}>
            <Box flexDirection="column">
              <Text color={editField === 'name' ? C_ACCENT : C_DIM} bold>Name</Text>
              {editField === 'name'
                ? <Box><Text color={C_WARNING}>{editName || <Text dimColor>type new name…</Text>}</Text><Text color={C_ACCENT}>█</Text></Box>
                : <Text dimColor>{editName || '(unchanged)'}</Text>
              }
            </Box>

            <Box flexDirection="column">
              <Text color={editField === 'category' ? C_ACCENT : C_DIM} bold>Category</Text>
              {editField === 'category' ? (
                <Box flexDirection="column">
                  {visibleCats.map((cat, i) => {
                    const idx = catWinStart + i;
                    const isSel = idx === editCatCursor;
                    return (
                      <Text key={cat} color={isSel ? C_ACCENT : undefined} dimColor={!isSel}>
                        {isSel ? '▶ ' : '  '}{cat}
                      </Text>
                    );
                  })}
                </Box>
              ) : (
                <Text color={C_ACCENT}>{categories[editCatCursor]}</Text>
              )}
            </Box>
          </Box>

          <Box marginTop={1} gap={3}>
            {editField === 'name'
              ? <Text dimColor>Enter / → to pick category  ·  Esc cancel</Text>
              : <><Text color={C_ACCENT}>[t] / Enter  this transaction</Text><Text color={C_ACCENT}>[r] make rule</Text><Text dimColor>← name  ·  Esc cancel</Text></>
            }
          </Box>
        </Box>
      )}

      {mode === 'edit-rule' && selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_MANUAL} paddingX={2} paddingY={1}>
          <Text bold>Make Rule</Text>
          {categories[editCatCursor] !== selected.category && (
            <Text dimColor>Category: <Text color={C_NEGATIVE}>{selected.category}</Text> → <Text color={C_ACCENT}>{categories[editCatCursor]}</Text></Text>
          )}
          {editName.trim().length > 0 && (
            <Text dimColor>Name: <Text color={C_POSITIVE}>{editName}</Text></Text>
          )}

          <Box gap={2} marginTop={1}>
            <Text>Pattern </Text>
            <Text color={C_MANUAL}>{editPattern}</Text><Text color={C_MANUAL}>█</Text>
          </Box>
          <Box gap={3} marginTop={1}>
            <Text color={editMatchType === 'name' ? C_NEUTRAL : undefined} dimColor={editMatchType !== 'name'}>[n] name</Text>
            <Text color={editMatchType === 'regex' ? C_NEUTRAL : undefined} dimColor={editMatchType !== 'regex'}>[x] regex</Text>
            <Text color={C_WARNING}>{matchCount} transactions match</Text>
          </Box>
          <Box marginTop={1}><Text dimColor>Enter save  ·  Esc back</Text></Box>
        </Box>
      )}
    </Box>
  );
}
