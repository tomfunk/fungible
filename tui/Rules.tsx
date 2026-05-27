import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { db } from '../core/db.js';
import { categorize } from '../core/categorize.js';
import { rebuildDisplayNames } from '../core/rename.js';
import { getAllRules, getAllNameRules, getAllCategories, getCategoryDetails, getHiddenCategorySet, toggleHiddenCategory, type Rule, type NameRule, type CategoryDetail } from '../core/queries.js';
import type { Screen, TxFilter } from './App.js';
import { Divider } from './fmt.js';
import { NavHints, handleNavKey } from './nav.js';
import { useTerminalWidth } from './useTerminalWidth.js';

type Flexibility = 'fixed' | 'flexible' | 'discretionary' | null;
const FLEX_CYCLE: Flexibility[] = [null, 'fixed', 'flexible', 'discretionary'];
const FLEX_COLORS: Record<string, string> = { fixed: 'red', flexible: 'yellow', discretionary: 'cyan' };
type Mode = 'list' | 'search' | 'add-pattern' | 'add-type' | 'add-min-amount' | 'add-max-amount' | 'add-category' | 'add-name-pattern' | 'add-name-type' | 'add-name-min-amount' | 'add-name-max-amount' | 'add-name-replacement' | 'add-category-name' | 'rename-category';
type Section = 'rules' | 'names' | 'categories';

const SECTIONS: Section[] = ['rules', 'names', 'categories'];

function getUncategorizedCount() {
  return (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE category = 'Uncategorized'").get() as { c: number }).c;
}

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

  function deleteRule(id: number) {
    db.prepare('DELETE FROM category_rules WHERE id = ?').run(id);
    setStatusMsg('Rule deleted');
    setTimeout(() => setStatusMsg(''), 2000);
    load();
  }

  function deleteNameRule(id: number) {
    db.prepare('DELETE FROM name_rules WHERE id = ?').run(id);
    rebuildDisplayNames();
    setStatusMsg('Name rule deleted');
    setTimeout(() => setStatusMsg(''), 2000);
    load();
  }

  function saveRule() {
    const category = categories[catCursor];
    const minAmt = newMinAmount.trim() ? parseFloat(newMinAmount) : null;
    const maxAmt = newMaxAmount.trim() ? parseFloat(newMaxAmount) : null;
    if (editingRuleId !== null) {
      db.prepare('UPDATE category_rules SET match_type = ?, pattern = ?, category = ?, min_amount = ?, max_amount = ? WHERE id = ?')
        .run(newType, newPattern, category, minAmt, maxAmt, editingRuleId);
      setEditingRuleId(null);
    } else {
      const existing = db.prepare('SELECT id FROM category_rules WHERE match_type = ? AND pattern = ?')
        .get(newType, newPattern) as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE category_rules SET category = ?, min_amount = ?, max_amount = ? WHERE id = ?').run(category, minAmt, maxAmt, existing.id);
      } else {
        db.prepare('INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount) VALUES (10, ?, ?, ?, ?, ?)')
          .run(newType, newPattern, category, minAmt, maxAmt);
      }
    }

    // Apply to all transactions without a manual override
    const rows = db.prepare(
      'SELECT id, name, merchant_name, raw_category, amount FROM transactions WHERE manual_category IS NULL'
    ).all() as { id: string; name: string; merchant_name: string | null; raw_category: string | null; amount: number }[];
    const update = db.prepare('UPDATE transactions SET category = ? WHERE id = ?');
    let count = 0;
    for (const tx of rows) {
      const cat = categorize(tx.name, tx.merchant_name, tx.raw_category, tx.amount);
      if (cat !== 'Uncategorized') { update.run(cat, tx.id); count++; }
    }

    setStatusMsg(`Rule saved · recategorized ${count} transactions`);
    setTimeout(() => setStatusMsg(''), 3000);
    setNewPattern('');
    setMode('list');
    load();
  }

  function saveNameRule() {
    const minAmt = newNameMinAmount.trim() ? parseFloat(newNameMinAmount) : null;
    const maxAmt = newNameMaxAmount.trim() ? parseFloat(newNameMaxAmount) : null;
    if (editingNameRuleId !== null) {
      db.prepare('UPDATE name_rules SET match_type = ?, pattern = ?, replacement = ?, min_amount = ?, max_amount = ? WHERE id = ?')
        .run(newNameType, newNamePattern, newReplacement, minAmt, maxAmt, editingNameRuleId);
      setEditingNameRuleId(null);
    } else {
      db.prepare('INSERT INTO name_rules (match_type, pattern, replacement, min_amount, max_amount) VALUES (?, ?, ?, ?, ?)')
        .run(newNameType, newNamePattern, newReplacement, minAmt, maxAmt);
    }
    rebuildDisplayNames();
    setStatusMsg(`Name rule saved`);
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
        if (input === 'd' && filteredRules[cursor]) { deleteRule(filteredRules[cursor].id); }
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
        if (input === 'd' && filteredNameRules[nameCursor]) { deleteNameRule(filteredNameRules[nameCursor].id); }
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
        if (input === 'h' && categories[catListCursor]) {
          const cat = categories[catListCursor];
          toggleHiddenCategory(cat, hiddenSet);
          setStatusMsg(`${cat} is now ${hiddenSet.has(cat) ? 'visible' : 'hidden'}`);
          setTimeout(() => setStatusMsg(''), 2000);
          load();
          return;
        }
        if (input === 'f' && catDetails[catListCursor]) {
          const cat = catDetails[catListCursor];
          const idx = FLEX_CYCLE.indexOf(cat.flexibility);
          const next = FLEX_CYCLE[(idx + 1) % FLEX_CYCLE.length];
          db.prepare('UPDATE categories SET flexibility = ? WHERE name = ?').run(next, cat.name);
          load();
          return;
        }
        if (input === 'r' && categories[catListCursor]) {
          setRenameCatInput(categories[catListCursor]);
          setMode('rename-category');
          return;
        }
        if (input === 'd' && categories[catListCursor]) {
          const name = categories[catListCursor];
          db.prepare("UPDATE transactions SET category = 'Uncategorized', manual_category = NULL WHERE category = ?").run(name);
          db.prepare('DELETE FROM hidden_categories WHERE category = ?').run(name);
          db.prepare('DELETE FROM categories WHERE name = ?').run(name);
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
      if (key.return) { if (newReplacement) saveNameRule(); return; }
      if (key.escape) { setMode('list'); return; }
      if (key.backspace || key.delete) { setNewReplacement((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewReplacement((p) => p + input);
    } else if (mode === 'add-category-name') {
      if (key.escape) { setMode('list'); return; }
      if (key.return && newCategoryName.trim()) {
        db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(newCategoryName.trim());
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
          db.prepare('INSERT OR IGNORE INTO categories (name, flexibility) SELECT ?, flexibility FROM categories WHERE name = ?').run(newName, oldName);
          db.prepare('UPDATE transactions SET category = ? WHERE category = ?').run(newName, oldName);
          db.prepare('UPDATE transactions SET manual_category = ? WHERE manual_category = ?').run(newName, oldName);
          db.prepare('UPDATE category_rules SET category = ? WHERE category = ?').run(newName, oldName);
          db.prepare('UPDATE hidden_categories SET category = ? WHERE category = ?').run(newName, oldName);
          db.prepare('DELETE FROM categories WHERE name = ?').run(oldName);
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
        <Text bold color="cyan">fungible</Text>
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
            ? '[a] add  [r] rename  [d] delete  [x] hidden  [f] flexibility  ·  [Tab] switch'
            : '[/] search  [a] add  [e] edit  [d] delete  ·  [Tab] switch'}
        </Text>}
      </Box>

      {mode === 'search' ? (
        <Box marginTop={1}>
          <Text color="cyan">/</Text>
          <Text>{search}</Text>
          <Text color="cyan">█</Text>
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
                <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▶ ' : '  '}</Text>
                <Text color="yellow" dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                <Text dimColor={!isSelected}>
                  {rule.pattern.length > rulePatW ? rule.pattern.slice(0, rulePatW - 1) + '…' : rule.pattern.padEnd(rulePatW)}
                </Text>
                {amtLabel ? <Text color="magenta" dimColor={!isSelected}>{amtLabel.padEnd(10)}</Text> : <Text>{' '.repeat(10)}</Text>}
                <Text color="cyan" dimColor={!isSelected}>{rule.category.length > ruleCatW ? rule.category.slice(0, ruleCatW - 1) + '…' : rule.category.padEnd(ruleCatW)}</Text>
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
                    <Text color={isSelected ? 'cyan' : 'white'}>{isSelected ? '▶ ' : '  '}</Text>
                    <Text color="yellow" dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                    <Text dimColor={!isSelected}>
                      {rule.pattern.length > namePatW ? rule.pattern.slice(0, namePatW - 1) + '…' : rule.pattern.padEnd(namePatW)}
                    </Text>
                    {amtLabel
                      ? <Text color="magenta" dimColor={!isSelected}>{amtLabel.padEnd(12)}</Text>
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
                  <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▶ ' : '  '}</Text>
                  <Text color={isSelected ? 'cyan' : undefined} dimColor={!isSelected}>{cat.name.length > catNameW ? cat.name.slice(0, catNameW - 1) + '…' : cat.name.padEnd(catNameW)}</Text>
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
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Pattern</Text>
          <Text dimColor>Type pattern · Enter · Esc cancel</Text>
          <Box marginTop={1}><Text>Pattern: </Text><Text color="yellow">{newPattern}<Text color="cyan">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-type' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Match Type</Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text></Text>
          <Box gap={4} marginTop={1}>
            <Text color="cyan">[n] name match</Text>
            <Text color="cyan">[r] regex match</Text>
          </Box>
        </Box>
      )}
      {mode === 'add-min-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Min Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  Type: <Text color="yellow">{newType}</Text></Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Min $: </Text><Text color="yellow">{newMinAmount}<Text color="cyan">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-max-amount' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Max Amount <Text dimColor>(optional)</Text></Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  {newMinAmount && <Text>Min: <Text color="magenta">${newMinAmount}</Text></Text>}</Text>
          <Text dimColor>Enter to skip · Esc cancel</Text>
          <Box marginTop={1}><Text>Max $: </Text><Text color="yellow">{newMaxAmount}<Text color="cyan">█</Text></Text></Box>
        </Box>
      )}
      {mode === 'add-category' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold>{editingRuleId !== null ? 'Edit' : 'New'} Rule — Category</Text>
          <Text>Pattern: <Text color="yellow">"{newPattern}"</Text>  Type: <Text color="yellow">{newType}</Text></Text>
          <Text dimColor>↑↓ select · Enter save · Esc cancel</Text>
          <Box flexDirection="column" marginTop={1}>
            {categories.map((cat, i) => (
              <Text key={cat} color={i === catCursor ? 'cyan' : 'white'} dimColor={i !== catCursor}>
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
          <Box marginTop={1}><Text>Name: </Text><Text color="yellow">{newCategoryName}<Text color="cyan">▊</Text></Text></Box>
        </Box>
      )}
      {mode === 'rename-category' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
          <Text bold>Rename Category</Text>
          <Text dimColor>Updates all transactions, rules, and hidden settings · Enter save · Esc cancel</Text>
          <Box marginTop={1}><Text>Name: </Text><Text color="yellow">{renameCatInput}<Text color="cyan">▊</Text></Text></Box>
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
          <Text>Pattern: <Text color="yellow">"{newNamePattern}"</Text>  {newNameMinAmount && <Text>Min: <Text color="magenta">${newNameMinAmount}</Text>  </Text>}</Text>
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
              <Text>  Amount: <Text color="magenta">
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
