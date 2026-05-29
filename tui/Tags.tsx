import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getTagSummary, getAllTags, type MonthlySummary, type Tag } from '../core/queries.js';
import { createTag, renameTag, deleteTag } from '../core/tags.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, bar, truncate, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth, CURSOR, C_POSITIVE, C_NEGATIVE, C_WARNING, C_ACCENT } from './ui.js';
import { useSetTyping } from './TypingContext.js';

type Mode = 'list' | 'search' | 'add' | 'detail' | 'rename';

export function Tags({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [newName, setNewName] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [search, setSearch] = useState('');
  const [tagSummary, setTagSummary] = useState<MonthlySummary | null>(null);
  const [catCursor, setCatCursor] = useState(0);

  function load() { void getAllTags().then(setTags); }
  useEffect(() => { load(); }, []);

  const setTyping = useSetTyping();
  useEffect(() => { setTyping(mode === 'search' || mode === 'add' || mode === 'rename'); }, [mode]);

  function openDetail(tag: Tag) {
    void getTagSummary(tag.name).then(setTagSummary);
    setCatCursor(0);
    setMode('detail');
  }

  const visibleTags = search
    ? tags.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    : tags;

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // [sel=2] gap [name] gap [count text~18] — 2 gaps of 2
  const tagNameW = Math.max(10, inner - 24);

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.escape) { setSearch(''); setMode('list'); setCursor(0); return; }
      if (key.return) { setMode('list'); return; }
      if (key.backspace || key.delete) { setSearch((s) => { const next = s.slice(0, -1); if (!next) setMode('list'); return next; }); return; }
      if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCursor((c) => Math.min(visibleTags.length - 1, c + 1)); return; }
      if (input && !key.ctrl && !key.meta) { setSearch((s) => s + input); setCursor(0); return; }
      return;
    }

    if (mode === 'add') {
      if (key.escape) { setMode('list'); setNewName(''); return; }
      if (key.return && newName.trim()) {
        createTag(newName.trim());
        setNewName('');
        setMode('list');
        load();
        return;
      }
      if (key.backspace || key.delete) { setNewName((n) => n.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setNewName((n) => n + input); return; }
      return;
    }

    if (mode === 'rename') {
      if (key.escape) { setMode('list'); setNewName(''); return; }
      if (key.return && newName.trim()) {
        const tag = visibleTags[cursor];
        if (tag) {
          renameTag(tag.id, newName.trim());
          load();
        }
        setNewName('');
        setMode('list');
        return;
      }
      if (key.backspace || key.delete) { setNewName((n) => n.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setNewName((n) => n + input); return; }
      return;
    }

    if (mode === 'detail') {
      if (key.escape) { setMode('list'); return; }
      if (key.leftArrow) {
        const next = Math.max(0, cursor - 1);
        setCursor(next);
        if (visibleTags[next]) { void getTagSummary(visibleTags[next].name).then(setTagSummary); setCatCursor(0); }
        return;
      }
      if (key.rightArrow) {
        const next = Math.min(visibleTags.length - 1, cursor + 1);
        setCursor(next);
        if (visibleTags[next]) { void getTagSummary(visibleTags[next].name).then(setTagSummary); setCatCursor(0); }
        return;
      }
      if (key.upArrow) { setCatCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCatCursor((c) => Math.min((tagSummary?.byCategory.length ?? 1) - 1, c + 1)); return; }
      if (key.return) {
        const tag = visibleTags[cursor];
        const cat = tagSummary?.byCategory[catCursor];
        if (tag) onNavigate('transactions', { tag: tag.name, category: cat?.category });
        return;
      }
      if (input === 't' && visibleTags[cursor]) {
        onNavigate('transactions', { tag: visibleTags[cursor].name });
        return;
      }
      if (handleNavKey(input, 'tags', onNavigate)) return;
      return;
    }

    // list mode
    if (handleNavKey(input, 'tags', onNavigate)) return;
    if (key.escape) {
      if (search) { setSearch(''); setCursor(0); return; }
      onNavigate('dashboard'); return;
    }
    if (input === '/') { setMode('search'); return; }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(visibleTags.length - 1, c + 1)); return; }
    if (input === 'a') { setNewName(''); setMode('add'); return; }
    if (input === 'n' && visibleTags[cursor]) { setNewName(visibleTags[cursor].name); setMode('rename'); return; }
    if (input === 'x' && visibleTags[cursor]) {
      const tag = visibleTags[cursor];
      deleteTag(tag.id);
      setStatusMsg(`Deleted "${tag.name}"`);
      setTimeout(() => setStatusMsg(''), 2000);
      setCursor((c) => Math.max(0, c - 1));
      load();
      return;
    }
    if (key.return && visibleTags[cursor]) {
      openDetail(visibleTags[cursor]);
      return;
    }
    if (input === 't' && visibleTags[cursor]) {
      onNavigate('transactions', { tag: visibleTags[cursor].name });
      return;
    }
  }, { isActive: isActive !== false });

  const tag = visibleTags[cursor];
  const maxCategorySpend = tagSummary?.byCategory[0]?.total ?? 1;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color={C_ACCENT}>fungible</Text>
        <NavHints current="tags" showHints={showHints} />
      </Box>

      {mode === 'detail' && tag && tagSummary ? (
        <>
          <Box justifyContent="space-between" marginTop={1} marginBottom={1}>
            <Text bold>Tags <Text dimColor>— # {tag.name}  ← {cursor + 1} / {tags.length} →</Text></Text>
            {showHints && <Text dimColor>← → tag  ·  ↑↓ category  ·  Enter txns  ·  [t] all txns  ·  Esc back</Text>}
          </Box>

          <Divider />

          <Box gap={6} marginY={1}>
            <Box flexDirection="column">
              <Text dimColor>Income</Text>
              <Text color={C_POSITIVE} bold>{fmt(tagSummary.income)}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>Expenses</Text>
              <Text color={C_NEGATIVE} bold>{fmt(tagSummary.expenses)}</Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>Net</Text>
              <Text color={tagSummary.net >= 0 ? C_POSITIVE : C_NEGATIVE} bold>
                {tagSummary.net >= 0 ? '+' : '-'}{fmt(tagSummary.net)}
              </Text>
            </Box>
            <Box flexDirection="column">
              <Text dimColor>Transactions</Text>
              <Text bold>{tag.count}</Text>
            </Box>
          </Box>

          <Divider />

          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>SPENDING BY CATEGORY</Text>
            <Box flexDirection="column" marginTop={1}>
              {tagSummary.byCategory.length === 0 ? (
                <Text dimColor>No expense data for this tag.</Text>
              ) : (
                tagSummary.byCategory.map((row, i) => {
                  const isSelected = catCursor === i;
                  return (
                    <Box key={row.category} gap={2}>
                      <Text color={isSelected ? C_ACCENT : undefined}>
                        {isSelected ? '▶ ' : '  '}
                        {truncate(row.category, 20).padEnd(20)}
                      </Text>
                      <Text color={C_WARNING}>{fmt(row.total).padStart(10)}</Text>
                      <Text color={C_ACCENT} dimColor={!isSelected}>{bar(row.total, maxCategorySpend)}</Text>
                    </Box>
                  );
                })
              )}
            </Box>
          </Box>
        </>
      ) : (
        <>
          <Box justifyContent="space-between" marginTop={1}>
            <Text bold>Tags{search ? <Text color={C_WARNING}>  /{search}</Text> : null}</Text>
            {showHints && <Text dimColor>[/] search  ·  [a] add  [n] rename  [x] delete  ·  Enter detail  ·  [t] transactions</Text>}
          </Box>
          {mode === 'search' && (
            <Box marginTop={1}>
              <Text color={C_ACCENT}>/</Text>
              <Text color={C_WARNING}>{search}</Text>
              <Text color={C_ACCENT}>█</Text>
              <Text dimColor>  Esc cancel</Text>
            </Box>
          )}
          <Box marginTop={1}><Divider /></Box>

          {visibleTags.length === 0 ? (
            <Box marginTop={1}><Text dimColor>{search ? `No tags matching "${search}".` : 'No tags yet. [a] to create one.'}</Text></Box>
          ) : (
            visibleTags.map((t, i) => {
              const isSelected = i === cursor;
              return (
                <Box key={t.id} gap={2} marginTop={i === 0 ? 1 : 0}>
                  <Text color={isSelected ? C_ACCENT : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                  <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>
                    {t.name.length > tagNameW ? t.name.slice(0, tagNameW - 1) + '…' : t.name.padEnd(tagNameW)}
                  </Text>
                  <Text dimColor>{t.count} transaction{t.count !== 1 ? 's' : ''}</Text>
                </Box>
              );
            })
          )}

          <Box marginTop={1}><Divider /></Box>
          <Text dimColor>{search ? `${visibleTags.length} of ${tags.length}` : `${tags.length}`} tag{tags.length !== 1 ? 's' : ''}</Text>
          {statusMsg && <Text color={C_POSITIVE}>{statusMsg}</Text>}

          {mode === 'add' && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
              <Text bold>New Tag</Text>
              <Text dimColor>Type name · Enter save · Esc cancel</Text>
              <Box marginTop={1}>
                <Text>Name: </Text>
                <Text color={C_WARNING}>{newName}</Text>
                <Text color={C_ACCENT}>{CURSOR}</Text>
              </Box>
            </Box>
          )}
          {mode === 'rename' && visibleTags[cursor] && (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_WARNING} paddingX={2} paddingY={1}>
              <Text bold>Rename Tag</Text>
              <Text dimColor>Enter save · Esc cancel</Text>
              <Box marginTop={1}>
                <Text>Name: </Text>
                <Text color={C_WARNING}>{newName}</Text>
                <Text color={C_ACCENT}>{CURSOR}</Text>
              </Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
