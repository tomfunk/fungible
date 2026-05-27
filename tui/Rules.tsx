import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAllRules, getAllNameRules, getAllCategories, getCategoryDetails, getHiddenCategorySet, toggleHiddenCategory, type Rule, type NameRule, type CategoryDetail } from '../core/queries.js';
import {
  getUncategorizedCount, deleteCategoryRule, deleteNameRule,
  saveCategoryRule, saveNameRule, setCategoryFlexibility,
  deleteCategory, renameCategory, createCategory,
} from '../core/rules.js';
import type { Screen, TxFilter } from './App.js';
import { truncate, Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth, CURSOR, FLEX_COLORS, C_ACCENT, C_MANUAL } from './ui.js';

type Flexibility = 'fixed' | 'flexible' | 'discretionary' | null;
const FLEX_CYCLE: Flexibility[] = [null, 'fixed', 'flexible', 'discretionary'];
type Mode = 'list' | 'search' | 'add-pattern' | 'add-type' | 'add-min-amount' | 'add-max-amount' | 'add-category' | 'add-name-pattern' | 'add-name-type' | 'add-name-min-amount' | 'add-name-max-amount' | 'add-name-replacement' | 'add-category-name' | 'rename-category';
type Section = 'rules' | 'names' | 'categories';

const SECTIONS: Section[] = ['rules', 'names', 'categories'];

export function Rules({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [nameRules, setNameRules] = useState<NameRule[]>([]);
  const [cursor, setCursor] = useState(0);
  const [nameCursor, setNameCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [section, setSection] = useState<Section>('rules');
  const [uncategorized, setUncategorized] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<string[]>([]);
  const [catListCursor, setCatListCursor] = useState(0);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [renameCatInput, setRenameCatInput] = useState('');
  const [catDetails, setCatDetails] = useState<CategoryDetail[]>([]);

  // New category rule state
  const [newPattern, setNewPattern] = useState('');
  const [newType, setNewType] = useState<'name' | 'regex'>('name');
  const [newMinAmount, setNewMinAmount] = useState('');
  const [newMaxAmount, setNewMaxAmount] = useState('');
  const [catCursor, setCatCursor] = useState(0);

  // New name rule state
  const [newNamePattern, setNewNamePattern] = useState('');
  const [newNameType, setNewNameType] = useState<'name' | 'regex'>('name');
  const [newNameMinAmount, setNewNameMinAmount] = useState('');
  const [newNameMaxAmount, setNewNameMaxAmount] = useState('');
  const [newReplacement, setNewReplacement] = useState('');

  // Editing
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editingNameRuleId, setEditingNameRuleId] = useState<number | null>(null);

  // Search
  const [search, setSearch] = useState('');

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  // Category rules: 6 children → 5 gaps of 2; fixed: sel(2)+type(5)+amt(10)+pri(3) = 20; total reserve = 20+10 = 30
  const rulesFlex = Math.max(20, inner - 30);
  const rulePatW = Math.max(12, Math.floor(rulesFlex * 0.5));
  const ruleCatW = Math.max(10, rulesFlex - rulePatW);
  // Name rules: 5 children → 4 gaps of 2; fixed: sel(2)+type(5)+amt(12) = 19; total reserve = 19+8 = 27
  const namesFlex = Math.max(20, inner - 27);
  const namePatW  = Math.max(12, Math.floor(namesFlex * 0.5));
  const nameReplW = Math.max(10, namesFlex - namePatW);
  // Categories: [sel=2] gap [name] gap [flex=14] gap [hidden=6]
  // reserve: 2+14+6 + 3gaps*2 = 28
  const catNameW = Math.max(12, inner - 28);

  function load() {
    setRules(getAllRules());
    setNameRules(getAllNameRules());
    setUncategorized(getUncategorizedCount());
    setHiddenSet(getHiddenCategorySet());
    setCategories(getAllCategories());
    setCatDetails(getCategoryDetails());
  }

  useEffect(() => { load(); }, []);

  function handleDeleteRule(id: number) {
    deleteCategoryRule(id);
    setStatusMsg('Rule deleted');
    setTimeout(() => setStatusMsg(''), 2000);
    load();
  }

  function handleDeleteNameRule(id: number) {
    deleteNameRule(id);
    setStatusMsg('Name rule deleted');
    setTimeout(() => setStatusMsg(''), 2000);
    load();
  }

  function saveRule() {
    const category = categories[catCursor];
    const minAmt = newMinAmount.trim() ? parseFloat(newMinAmount) : null;
    const maxAmt = newMaxAmount.trim() ? parseFloat(newMaxAmount) : null;
    const count = saveCategoryRule({
      pattern: newPattern, matchType: newType, category,
      minAmount: minAmt, maxAmount: maxAmt,
      editingId: editingRuleId,
    });
    setEditingRuleId(null);
    setStatusMsg(`Rule saved · recategorized ${count} transactions`);
    setTimeout(() => setStatusMsg(''), 3000);
    setNewPattern('');
    setMode('list');
    load();
  }

  function handleSaveNameRule() {
    const minAmt = newNameMinAmount.trim() ? parseFloat(newNameMinAmount) : null;
    const maxAmt = newNameMaxAmount.trim() ? parseFloat(newNameMaxAmount) : null;
    saveNameRule({
      pattern: newNamePattern, matchType: newNameType, replacement: newReplacement,
      minAmount: minAmt, maxAmount: maxAmt,
      editingId: editingNameRuleId,
    });
    setEditingNameRuleId(null);
    setStatusMsg('Name rule saved');
    setTimeout(() => setStatusMsg(''), 3000);
    setNewNamePattern('');
    setNewReplacement('');
    setNewNameMinAmount('');
    setNewNameMaxAmount('');
    setMode('list');
    load();
  }

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.escape) { setSearch(''); setMode('list'); return; }
      if (key.return) { setMode('list'); return; }
      if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setSearch((s) => s + input);
      return;
    }

    if (mode === 'list') {
      if (handleNavKey(input, 'rules', onNavigate)) return;
      if (key.escape) {
        if (search) { setSearch(''); return; }
        onNavigate('dashboard');
        return;
      }

      if (key.tab) {
        setSearch('');
        setSection((s) => { const i = SECTIONS.indexOf(s); return SECTIONS[(i + 1) % SECTIONS.length]; });
        return;
      }

      if (section === 'rules' || section === 'names') {
        if (input === '/') { setMode('search'); return; }
      }


      if (section === 'rules') {
        if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setCursor((c) => Math.min(filteredRules.length - 1, c + 1));
        if (input === 'a') { setEditingRuleId(null); setNewPattern(''); setNewType('name'); setNewMinAmount(''); setNewMaxAmount(''); setCatCursor(0); setMode('add-pattern'); }
        if (input === 'x' && filteredRules[cursor]) { handleDeleteRule(filteredRules[cursor].id); }
        if ((input === 'e' || key.return) && filteredRules[cursor]) {
          const r = filteredRules[cursor];
          setEditingRuleId(r.id);
          setNewPattern(r.pattern);
          setNewType(r.match_type as 'name' | 'regex');
          setNewMinAmount(r.min_amount !== null ? String(r.min_amount) : '');
          setNewMaxAmount(r.max_amount !== null ? String(r.max_amount) : '');
          setCatCursor(Math.max(0, categories.indexOf(r.category)));
          setMode('add-pattern');
        }
      } else if (section === 'names') {
        if (key.upArrow) setNameCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setNameCursor((c) => Math.min(filteredNameRules.length - 1, c + 1));
        if (input === 'a') { setEditingNameRuleId(null); setNewNamePattern(''); setNewNameType('name'); setNewNameMinAmount(''); setNewNameMaxAmount(''); setNewReplacement(''); setMode('add-name-pattern'); }
        if (input === 'x' && filteredNameRules[nameCursor]) { handleDeleteNameRule(filteredNameRules[nameCursor].id); }
        if ((input === 'e' || key.return) && filteredNameRules[nameCursor]) {
          const r = filteredNameRules[nameCursor];
          setEditingNameRuleId(r.id);
          setNewNamePattern(r.pattern);
          setNewNameType(r.match_type as 'name' | 'regex');
          setNewNameMinAmount(r.min_amount !== null ? String(r.min_amount) : '');
          setNewNameMaxAmount(r.max_amount !== null ? String(r.max_amount) : '');
          setNewReplacement(r.replacement);
          setMode('add-name-pattern');
        }
      } else if (section === 'categories') {
        if (key.upArrow) setCatListCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setCatListCursor((c) => Math.min(categories.length - 1, c + 1));
        if (input === 'a') { setNewCategoryName(''); setMode('add-category-name'); return; }
        if (input === 'v' && categories[catListCursor]) {
          const cat = categories[catListCursor];
          const nowHidden = !hiddenSet.has(cat);
          toggleHiddenCategory(cat, hiddenSet);
          setHiddenSet(getHiddenCategorySet());
          setStatusMsg(`${cat} is now ${nowHidden ? 'hidden' : 'visible'}`);
          setTimeout(() => setStatusMsg(''), 2000);
          return;
        }
        if (input === 'f' && catDetails[catListCursor]) {
          const cat = catDetails[catListCursor];
          const idx = FLEX_CYCLE.indexOf(cat.flexibility);
          const next = FLEX_CYCLE[(idx + 1) % FLEX_CYCLE.length];
          setCategoryFlexibility(cat.name, next);
          load();
          return;
        }
        if (input === 'n' && categories[catListCursor]) {
          setRenameCatInput(categories[catListCursor]);
          setMode('rename-category');
          return;
        }
        if (input === 'x' && categories[catListCursor]) {
          const name = categories[catListCursor];
          deleteCategory(name);
          setStatusMsg(`Deleted "${name}"`);
          setTimeout(() => setStatusMsg(''), 2000);
          load();
          setCatListCursor((c) => Math.max(0, c - 1));
        }
      }
    } else if (mode === 'add-pattern') {
      if (key.return) { if (newPattern) setMode('add-type'); return; }
      if (key.escape) { setEditingRuleId(null); setMode('list'); return; }
      if (key.backspace || key.delete) { setNewPattern((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewPattern((p) => p + input);
    } else if (mode === 'add-type') {
      if (key.escape) { setMode('list'); return; }
      if (input === 'n') { setNewType('name'); setNewMinAmount(''); setNewMaxAmount(''); setMode('add-min-amount'); }
      if (input === 'r') { setNewType('regex'); setNewMinAmount(''); setNewMaxAmount(''); setMode('add-min-amount'); }
    } else if (mode === 'add-min-amount') {
      if (key.escape) { setMode('list'); return; }
      if (key.return) { setMode('add-max-amount'); return; }
      if (key.backspace || key.delete) { setNewMinAmount((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewMinAmount((p) => p + input);
    } else if (mode === 'add-max-amount') {
      if (key.escape) { setMode('list'); return; }
      if (key.return) { setMode('add-category'); return; }
      if (key.backspace || key.delete) { setNewMaxAmount((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewMaxAmount((p) => p + input);
    } else if (mode === 'add-category') {
      if (key.escape) { setMode('list'); return; }
      if (key.upArrow) setCatCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCatCursor((c) => Math.min(categories.length - 1, c + 1));
      if (key.return) saveRule();
    } else if (mode === 'add-name-pattern') {
      if (key.return) { if (newNamePattern) setMode('add-name-type'); return; }
      if (key.escape) { setEditingNameRuleId(null); setMode('list'); return; }
      if (key.backspace || key.delete) { setNewNamePattern((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewNamePattern((p) => p + input);
    } else if (mode === 'add-name-type') {
      if (key.escape) { setMode('list'); return; }
      if (input === 'n') { setNewNameType('name'); setMode('add-name-min-amount'); }
      if (input === 'r') { setNewNameType('regex'); setMode('add-name-min-amount'); }
    } else if (mode === 'add-name-min-amount') {
      if (key.escape) { setMode('list'); return; }
      if (key.return) { setMode('add-name-max-amount'); return; }
      if (key.backspace || key.delete) { setNewNameMinAmount((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewNameMinAmount((p) => p + input);
    } else if (mode === 'add-name-max-amount') {
      if (key.escape) { setMode('list'); return; }
      if (key.return) { setMode('add-name-replacement'); return; }
      if (key.backspace || key.delete) { setNewNameMaxAmount((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewNameMaxAmount((p) => p + input);
    } else if (mode === 'add-name-replacement') {
      if (key.return) { if (newReplacement) handleSaveNameRule(); return; }
      if (key.escape) { setMode('list'); return; }
      if (key.backspace || key.delete) { setNewReplacement((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewReplacement((p) => p + input);
    } else if (mode === 'add-category-name') {
      if (key.escape) { setMode('list'); return; }
      if (key.return && newCategoryName.trim()) {
        createCategory(newCategoryName.trim());
        setStatusMsg(`Added "${newCategoryName.trim()}"`);
        setTimeout(() => setStatusMsg(''), 2000);
        setNewCategoryName('');
        setMode('list');
        load();
        return;
      }
      if (key.backspace || key.delete) { setNewCategoryName((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewCategoryName((p) => p + input);
    } else if (mode === 'rename-category') {
      if (key.escape) { setMode('list'); return; }
      if (key.return && renameCatInput.trim()) {
        const oldName = categories[catListCursor];
        const newName = renameCatInput.trim();
        if (oldName && newName !== oldName) {
          renameCategory(oldName, newName);
          setStatusMsg(`Renamed to "${newName}"`);
          setTimeout(() => setStatusMsg(''), 2000);
          load();
        }
        setMode('list');
        return;
      }
      if (key.backspace || key.delete) { setRenameCatInput((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setRenameCatInput((p) => p + input);
    }
  }, { isActive: isActive !== false });

  const q = search.toLowerCase();
  const filteredRules = q
    ? rules.filter((r) => r.pattern.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
    : rules;
  const filteredNameRules = q
    ? nameRules.filter((r) => r.pattern.toLowerCase().includes(q) || r.replacement.toLowerCase().includes(q))
    : nameRules;

  const PAGE = 20;
  const pageStart = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), filteredRules.length - PAGE));
  const visible = filteredRules.slice(pageStart, pageStart + PAGE);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color={C_ACCENT}>fungible</Text>
        <NavHints current="rules" showHints={showHints} />
      </Box>
      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={3}>
          {SECTIONS.map((s) => (
            <Text key={s} bold color={section === s ? 'white' : undefined} dimColor={section !== s}>
              {s === 'rules' ? 'Category Rules' : s === 'names' ? 'Name Rules' : 'Categories'}
            </Text>
          ))}
        </Box>
        {showHints && <Text dimColor>
          {section === 'categories'
            ? '[a] add  [n] rename  [x] delete  [v] hidden  [f] flexibility  ·  [Tab] switch'
            : '[/] search  [a] add  [e] edit  [x] delete  ·  [Tab] switch'}
        </Text>}
      </Box>

      {mode === 'search' ? (
        <Box marginTop={1}>
          <Text color={C_ACCENT}>/</Text>
          <Text>{search}</Text>
          <Text color={C_ACCENT}>█</Text>
          <Text dimColor>  Esc clear</Text>
        </Box>
      ) : search ? (
        <Box marginTop={1} gap={1}>
          <Text color="yellow">"{search}"</Text>
          <Text dimColor>· Esc to clear</Text>
        </Box>
      ) : null}
      <Box marginTop={1}><Divider /></Box>

      {section === 'rules' && (
        <>
          <Box gap={2} marginTop={1}>
            <Text dimColor>{'TYPE  '.padEnd(6)}</Text>
            <Text dimColor>{'PATTERN'.padEnd(rulePatW)}</Text>
            <Text dimColor>{'CATEGORY'.padEnd(ruleCatW)}</Text>
            <Text dimColor>PRI</Text>
          </Box>
          {visible.map((rule) => {
            const isSelected = rule.id === filteredRules[cursor]?.id;
            const amtLabel = rule.min_amount !== null && rule.max_amount !== null && rule.min_amount === rule.max_amount
              ? `$${rule.min_amount}`
              : rule.min_amount !== null && rule.max_amount !== null
              ? `$${rule.min_amount}-$${rule.max_amount}`
              : rule.min_amount !== null ? `≥$${rule.min_amount}`
              : rule.max_amount !== null ? `≤$${rule.max_amount}`
              : '';
            return (
              <Box key={rule.id} gap={2}>
                <Text color={isSelected ? C_ACCENT : 'white'}>{isSelected ? '▶ ' : '  '}</Text>
                <Text color="yellow" dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                <Text dimColor={!isSelected}>
                  {rule.pattern.length > rulePatW ? rule.pattern.slice(0, rulePatW - 1) + '…' : rule.pattern.padEnd(rulePatW)}
                </Text>
                {amtLabel ? <Text color={C_MANUAL} dimColor={!isSelected}>{truncate(amtLabel, 10).padEnd(10)}</Text> : <Text>{' '.repeat(10)}</Text>}
                <Text color={C_ACCENT} dimColor={!isSelected}>{rule.category.length > ruleCatW ? rule.category.slice(0, ruleCatW - 1) + '…' : rule.category.padEnd(ruleCatW)}</Text>
                <Text dimColor>{rule.priority}</Text>
              </Box>
            );
          })}
          <Divider />
          <Box gap={4}>
            <Text dimColor>{filteredRules.length}{search ? `/${rules.length}` : ''} rules</Text>
            {uncategorized > 0 && <Text color="yellow">{uncategorized} uncategorized transactions</Text>}
          </Box>
        </>
      )}

      {section === 'names' && (
        <>
          <Box gap={2} marginTop={1}>
            <Text dimColor>{'TYPE  '.padEnd(6)}</Text>
            <Text dimColor>{'PATTERN'.padEnd(namePatW)}</Text>
            <Text dimColor>{'AMOUNT'.padEnd(12)}</Text>
            <Text dimColor>REPLACEMENT</Text>
          </Box>
          {filteredNameRules.length === 0
            ? <Box marginTop={1}><Text dimColor>{nameRules.length === 0 ? 'No name rules yet. [a] to add one.' : 'No matches.'}</Text></Box>
            : filteredNameRules.map((rule, i) => {
                const isSelected = nameCursor === i;
                const amtLabel = rule.min_amount !== null && rule.max_amount !== null && rule.min_amount === rule.max_amount
                  ? `$${rule.min_amount}`
                  : rule.min_amount !== null && rule.max_amount !== null
                  ? `$${rule.min_amount}-$${rule.max_amount}`
                  : rule.min_amount !== null ? `≥$${rule.min_amount}`
                  : rule.max_amount !== null ? `≤$${rule.max_amount}`
                  : '';
                return (
                  <Box key={rule.id} gap={2}>
                    <Text color={isSelected ? C_ACCENT : 'white'}>{isSelected ? '▶ ' : '  '}</Text>
                    <Text color="yellow" dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                    <Text dimColor={!isSelected}>
                      {rule.pattern.length > namePatW ? rule.pattern.slice(0, namePatW - 1) + '…' : rule.pattern.padEnd(namePatW)}
                    </Text>
                    {amtLabel
                      ? <Text color={C_MANUAL} dimColor={!isSelected}>{truncate(amtLabel, 12).padEnd(12)}</Text>
                      : <Text>{' '.repeat(12)}</Text>}
                    <Text color="green" dimColor={!isSelected}>{rule.replacement.length > nameReplW ? rule.replacement.slice(0, nameReplW - 1) + '…' : rule.replacement}</Text>
                  </Box>
                );
              })}
          <Divider />
          <Text dimColor>{filteredNameRules.length}{search ? `/${nameRules.length}` : ''} name rule{nameRules.length !== 1 ? 's' : ''}</Text>
        </>
      )}

      {section === 'categories' && (
        <>
          <Box gap={2} marginTop={1} marginBottom={1}>
            <Text dimColor>{'NAME'.padEnd(catNameW + 2)}</Text>
            <Text dimColor>{'FLEXIBILITY'.padEnd(16)}</Text>
            <Text dimColor>HIDDEN</Text>
          </Box>
          <Box flexDirection="column">
            {catDetails.map((cat, i) => {
              const isSelected = catListCursor === i;
              const isHidden = hiddenSet.has(cat.name);
              const flexColor = cat.flexibility ? FLEX_COLORS[cat.flexibility] : undefined;
              return (
                <Box key={cat.name} gap={2}>
                  <Text color={isSelected ? C_ACCENT : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                  <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>{cat.name.length > catNameW ? cat.name.slice(0, catNameW - 1) + '…' : cat.name.padEnd(catNameW)}</Text>
                  {cat.flexibility
                    ? <Text color={flexColor} dimColor={!isSelected}>{cat.flexibility.padEnd(14)}</Text>
                    : <Text dimColor>{'—'.padEnd(14)}</Text>}
                  {isHidden
                    ? <Text color="yellow" dimColor={!isSelected}>hidden</Text>
                    : <Text dimColor>—</Text>}
                </Box>
              );
            })}
          </Box>
          <Divider />
          <Box gap={4}>
            <Text dimColor>{categories.length} categories</Text>
            {hiddenSet.size > 0 && <Text dimColor>{hiddenSet.size} hidden from totals</Text>}
          </Box>
        </>
      )}

      {statusMsg && <Text color="green" bold>{statusMsg}</Text>}

      {mode === 'add-pattern' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Pattern</Text>
          <Text dimColor>Type pattern · Enter · Esc cancel</Text>
          <Box marginTop={1}><Text>Pattern: </Text><Text color="yellow">{newPattern}<Text color={C_ACCENT}>█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-type' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Match Type</Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text></Text>
          <Box gap={4} marginTop={1}>
            <Text color={C_ACCENT}>[n] name match</Text>
            <Text color={C_ACCENT}>[r] regex match</Text>
          </Box>
        </Box>
      )}
      {mode === 'add-min-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Min Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  Type: <Text color="yellow">{newType}</Text></Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Min $: </Text><Text color="yellow">{newMinAmount}<Text color={C_ACCENT}>█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-max-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Max Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  {newMinAmount && <Text>Min: <Text color={C_MANUAL}>${newMinAmount}</Text></Text>}</Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Max $: </Text><Text color="yellow">{newMaxAmount}<Text color={C_ACCENT}>█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-category' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={C_ACCENT} paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Category</Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  Type: <Text color="yellow">{newType}</Text></Text>
          <Text dimColor>↑↓ select · Enter save · Esc cancel</Text>
          <Box flexDirection="column" marginTop={1}>
            {categories.map((cat, i) => (
              <Text key={cat} color={i === catCursor ? C_ACCENT : 'white'} dimColor={i !== catCursor}>
                {i === catCursor ? '▶ ' : '  '}{cat}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {mode === 'add-name-pattern' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold>{editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule — Pattern</Text>
          <Text dimColor>Matches against the raw transaction name</Text>
          <Box marginTop={1}><Text>Pattern: </Text><Text color="yellow">{newNamePattern}<Text color="green">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-name-type' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold>{editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule — Match Type</Text>
          <Text>Pattern: <Text color="yellow">"{newNamePattern}"</Text></Text>
          <Box gap={4} marginTop={1}>
            <Text color="green">[n] name match (replaces whole name)</Text>
            <Text color="green">[r] regex (can use capture groups)</Text>
          </Box>
        </Box>
      )}
      {mode === 'add-category-name' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
          <Text bold>New Category</Text>
          <Text dimColor>Type a name · Enter save · Esc cancel</Text>
          <Box marginTop={1}><Text>Name: </Text><Text color="yellow">{newCategoryName}<Text color={C_ACCENT}>{CURSOR}</Text></Text></Box>
        </Box>
      )}
      {mode === 'rename-category' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
          <Text bold>Rename Category</Text>
          <Text dimColor>Updates all transactions, rules, and hidden settings · Enter save · Esc cancel</Text>
          <Box marginTop={1}><Text>Name: </Text><Text color="yellow">{renameCatInput}<Text color={C_ACCENT}>{CURSOR}</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-name-min-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold>{editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule — Min Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newNamePattern}"</Text>  Type: <Text color="yellow">{newNameType}</Text></Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Min $: </Text><Text color="yellow">{newNameMinAmount}<Text color="green">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-name-max-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold>{editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule — Max Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newNamePattern}"</Text>  {newNameMinAmount && <Text>Min: <Text color={C_MANUAL}>${newNameMinAmount}</Text>  </Text>}</Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Max $: </Text><Text color="yellow">{newNameMaxAmount}<Text color="green">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-name-replacement' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold>{editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule — Replacement</Text>
          <Text>
            Pattern: <Text color="yellow">"{newNamePattern}"</Text>  Type: <Text color="yellow">{newNameType}</Text>
            {(newNameMinAmount || newNameMaxAmount) && (
              <Text>  Amount: <Text color={C_MANUAL}>
                {newNameMinAmount && newNameMaxAmount && newNameMinAmount === newNameMaxAmount
                  ? `$${newNameMinAmount}`
                  : newNameMinAmount && newNameMaxAmount
                  ? `$${newNameMinAmount}–$${newNameMaxAmount}`
                  : newNameMinAmount ? `≥$${newNameMinAmount}` : `≤$${newNameMaxAmount}`}
              </Text></Text>
            )}
          </Text>
          <Text dimColor>The display name to show instead</Text>
          <Box marginTop={1}><Text>Replace with: </Text><Text color="green">{newReplacement}<Text color="green">█</Text></Text></Box>
        </Box>
      )}
    </Box>
  );
}
