import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { getAllRules, getAllNameRules, getAllTagRules, getAllCategories, getCategoryDetails, getHiddenCategorySet, toggleHiddenCategory, getLinkedAccounts, type Rule, type NameRule, type TagRuleRow, type CategoryDetail, type LinkedAccount } from '../core/queries.js';
import {
  getUncategorizedCount, deleteCategoryRule, deleteNameRule,
  saveCategoryRule, saveNameRule, saveTagRule, deleteTagRule, setCategoryFlexibility,
  deleteCategory, renameCategory, createCategory,
} from '../core/rules.js';
import { getTagOptions, type TagOption } from '../core/tags.js';
import { countTagRuleMatches, type TagMatchType } from '../core/tag-rules.js';
import type { Screen, TxFilter } from './App.js';
import { truncate, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, FLEX_COLORS, C_ACCENT, C_DIM, C_MANUAL, C_NEUTRAL, C_POSITIVE, C_WARNING } from './ui.js';
import { useRefreshKey } from './RefreshContext.js';
import { useSetTyping } from './TypingContext.js';
import { ModalPanel, TextInput, SelectableRow, usePagination, useStatusMessage, ColumnHeader, PageHeader, SearchBar, EditTextField, EditToggleField } from './components/index.js';

type Flexibility = 'fixed' | 'flexible' | 'discretionary' | null;
const FLEX_CYCLE: Flexibility[] = [null, 'fixed', 'flexible', 'discretionary'];
type Mode = 'list' | 'search' | 'rule-form' | 'name-rule-form' | 'tag-rule-form' | 'add-category-name' | 'edit-category';
type CatEditField = 'name' | 'flexibility' | 'hidden';
type RuleField = 'pattern' | 'type' | 'min' | 'max' | 'category' | 'account';
type NameRuleField = 'pattern' | 'type' | 'min' | 'max' | 'replacement' | 'account';
type TagRuleField = 'type' | 'pattern' | 'min' | 'max' | 'tag' | 'account';
const RULE_FIELDS: RuleField[] = ['pattern', 'type', 'min', 'max', 'category', 'account'];
const NAME_RULE_FIELDS: NameRuleField[] = ['pattern', 'type', 'min', 'max', 'replacement', 'account'];
const TAG_MATCH_TYPES: TagMatchType[] = ['all', 'name', 'regex'];
type Section = 'rules' | 'names' | 'tags' | 'categories';

const SECTIONS: Section[] = ['rules', 'names', 'tags', 'categories'];

export function Rules({ onNavigate, isActive, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; showHints: boolean }) {
  const refreshKey = useRefreshKey();
  const [rules, setRules] = useState<Rule[]>([]);
  const [nameRules, setNameRules] = useState<NameRule[]>([]);
  const [cursor, setCursor] = useState(0);
  const [nameCursor, setNameCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [section, setSection] = useState<Section>('rules');
  const [uncategorized, setUncategorized] = useState(0);
  const { statusMsg, showStatus } = useStatusMessage();
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

  // Tag rules
  const [tagRules, setTagRules] = useState<TagRuleRow[]>([]);
  const [tagRuleCursor, setTagRuleCursor] = useState(0);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [newTagType, setNewTagType] = useState<TagMatchType>('all');
  const [newTagPattern, setNewTagPattern] = useState('');
  const [newTagMinAmount, setNewTagMinAmount] = useState('');
  const [newTagMaxAmount, setNewTagMaxAmount] = useState('');
  const [tagPickCursor, setTagPickCursor] = useState(0);
  const [editingTagRuleId, setEditingTagRuleId] = useState<number | null>(null);
  const [tagRuleField, setTagRuleField] = useState<TagRuleField>('type');
  const [tagMatchCount, setTagMatchCount] = useState(0);

  // Account scoping (shared by both rule forms; only one is active at a time)
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [accountCursor, setAccountCursor] = useState(0); // 0 = All accounts; i>0 → accounts[i-1]

  // Editing
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editingNameRuleId, setEditingNameRuleId] = useState<number | null>(null);

  // Category edit panel state
  const [catEditField, setCatEditField] = useState<CatEditField>('flexibility');

  // Unified rule form field cursor
  const [ruleField, setRuleField] = useState<RuleField>('pattern');
  const [nameRuleField, setNameRuleField] = useState<NameRuleField>('pattern');

  // Search
  const [search, setSearch] = useState('');

  const setTyping = useSetTyping();
  const TEXT_INPUT_MODES_RULES = new Set<Mode>(['search', 'rule-form', 'name-rule-form', 'tag-rule-form', 'add-category-name', 'edit-category']);
  useEffect(() => { setTyping(TEXT_INPUT_MODES_RULES.has(mode)); }, [mode]);

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
    void getAllRules().then(setRules);
    void getAllNameRules().then(setNameRules);
    void getAllTagRules().then(setTagRules);
    void getTagOptions().then(setTagOptions);
    void getUncategorizedCount().then(setUncategorized);
    void getHiddenCategorySet().then(setHiddenSet);
    void getAllCategories().then(setCategories);
    void getCategoryDetails().then(setCatDetails);
    // Drop not-yet-synced institution placeholders — they have no transactions,
    // so they don't belong in an account picker.
    void getLinkedAccounts().then((accts) => setAccounts(accts.filter((a) => !a.awaitingFirstSync)));
  }

  // Tag-rule form field order (pattern is hidden/ignored for match type 'all').
  const tagRuleFields: TagRuleField[] = newTagType === 'all'
    ? ['type', 'min', 'max', 'tag', 'account']
    : ['type', 'pattern', 'min', 'max', 'tag', 'account'];

  // Live "blast radius" count for the tag-rule editor (esp. match type 'all').
  useEffect(() => {
    if (mode !== 'tag-rule-form') return;
    if (newTagType !== 'all' && !newTagPattern.trim()) { setTagMatchCount(0); return; }
    let cancelled = false;
    const minAmt = newTagMinAmount.trim() ? parseFloat(newTagMinAmount) : null;
    const maxAmt = newTagMaxAmount.trim() ? parseFloat(newTagMaxAmount) : null;
    void countTagRuleMatches(newTagType, newTagPattern, accountOptions[accountCursor] ?? null, minAmt, maxAmt)
      .then((n) => { if (!cancelled) setTagMatchCount(n); })
      .catch(() => { if (!cancelled) setTagMatchCount(0); });
    return () => { cancelled = true; };
  }, [mode, newTagType, newTagPattern, accountCursor, newTagMinAmount, newTagMaxAmount]);

  // Account picker options: index 0 = "All accounts" (global), then one per account.
  const accountOptions: (string | null)[] = [null, ...accounts.map((a) => a.id)];
  const accountLabel = (id: string | null): string => {
    if (id === null) return 'All accounts';
    const a = accounts.find((x) => x.id === id);
    return a ? (a.nickname ?? a.name) : id;
  };
  const accountCursorFor = (id: string | null): number => {
    const i = accountOptions.indexOf(id);
    return i >= 0 ? i : 0;
  };

  useEffect(() => { load(); }, [refreshKey]);

  async function handleDeleteRule(id: number) {
    const count = await deleteCategoryRule(id);
    showStatus(`Rule deleted · recategorized ${count} transaction${count === 1 ? '' : 's'}`, 3000);
    load();
  }

  function handleDeleteNameRule(id: number) {
    deleteNameRule(id);
    showStatus('Name rule deleted');
    load();
  }

  async function saveRule() {
    const category = categories[catCursor];
    const minAmt = newMinAmount.trim() ? parseFloat(newMinAmount) : null;
    const maxAmt = newMaxAmount.trim() ? parseFloat(newMaxAmount) : null;
    let count: number;
    try {
      count = await saveCategoryRule({
        pattern: newPattern, matchType: newType, category,
        minAmount: minAmt, maxAmount: maxAmt,
        accountId: accountOptions[accountCursor] ?? null,
        editingId: editingRuleId,
      });
    } catch (e) {
      showStatus(e instanceof Error ? e.message : 'Failed to save rule', 4000);
      return;
    }
    setEditingRuleId(null);
    showStatus(`Rule saved · recategorized ${count} transaction${count === 1 ? '' : 's'}`, 3000);
    setNewPattern('');
    setMode('list');
    load();
  }

  async function handleSaveNameRule() {
    const minAmt = newNameMinAmount.trim() ? parseFloat(newNameMinAmount) : null;
    const maxAmt = newNameMaxAmount.trim() ? parseFloat(newNameMaxAmount) : null;
    try {
      await saveNameRule({
        pattern: newNamePattern, matchType: newNameType, replacement: newReplacement,
        minAmount: minAmt, maxAmount: maxAmt,
        accountId: accountOptions[accountCursor] ?? null,
        editingId: editingNameRuleId,
      });
    } catch (e) {
      showStatus(e instanceof Error ? e.message : 'Failed to save name rule', 4000);
      return;
    }
    setEditingNameRuleId(null);
    showStatus('Name rule saved', 3000);
    setNewNamePattern('');
    setNewReplacement('');
    setNewNameMinAmount('');
    setNewNameMaxAmount('');
    setMode('list');
    load();
  }

  async function saveTagRuleForm() {
    const tag = tagOptions[tagPickCursor];
    if (!tag) { showStatus('Create a tag first'); return; }
    const minAmt = newTagMinAmount.trim() ? parseFloat(newTagMinAmount) : null;
    const maxAmt = newTagMaxAmount.trim() ? parseFloat(newTagMaxAmount) : null;
    let count: number;
    try {
      count = await saveTagRule({
        matchType: newTagType, pattern: newTagPattern, tagId: tag.id,
        minAmount: minAmt, maxAmount: maxAmt,
        accountId: accountOptions[accountCursor] ?? null,
        editingId: editingTagRuleId,
      });
    } catch (e) {
      showStatus(e instanceof Error ? e.message : 'Failed to save tag rule', 4000);
      return;
    }
    setEditingTagRuleId(null);
    showStatus(`Tag rule saved · tagged ${count} transaction${count === 1 ? '' : 's'}`, 3000);
    setNewTagPattern('');
    setMode('list');
    load();
  }

  function handleDeleteTagRule(id: number) {
    deleteTagRule(id);
    showStatus('Tag rule deleted · existing tags left in place');
    load();
  }

  // Clearing the search filter shifts which rule sits under a given numeric
  // cursor index, so re-anchor the cursor to the rule the user was looking at
  // (by id) — otherwise Esc-then-'x' deletes the wrong rule.
  function clearSearchPreservingCursor() {
    if (section === 'rules' && filteredRules[cursor]) {
      const id = filteredRules[cursor].id;
      const idx = rules.findIndex((r) => r.id === id);
      setSearch('');
      if (idx >= 0) setCursor(idx);
    } else if (section === 'names' && filteredNameRules[nameCursor]) {
      const id = filteredNameRules[nameCursor].id;
      const idx = nameRules.findIndex((r) => r.id === id);
      setSearch('');
      if (idx >= 0) setNameCursor(idx);
    } else if (section === 'tags' && filteredTagRules[tagRuleCursor]) {
      const id = filteredTagRules[tagRuleCursor].id;
      const idx = tagRules.findIndex((r) => r.id === id);
      setSearch('');
      if (idx >= 0) setTagRuleCursor(idx);
    } else {
      setSearch('');
    }
  }

  useInput((input, key) => {
    if (mode === 'search') {
      if (key.escape) { clearSearchPreservingCursor(); setMode('list'); return; }
      if (key.return) { setMode('list'); return; }
      if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setSearch((s) => s + input);
      return;
    }

    if (mode === 'list') {
      if (handleNavKey(input, 'rules', onNavigate)) return;
      if (key.escape) {
        if (search) { clearSearchPreservingCursor(); return; }
        onNavigate('dashboard');
        return;
      }

      if (key.tab) {
        setSearch('');
        setSection((s) => { const i = SECTIONS.indexOf(s); return SECTIONS[(i + 1) % SECTIONS.length]; });
        return;
      }

      if (section === 'rules' || section === 'names' || section === 'tags') {
        if (input === '/') { setMode('search'); return; }
      }


      if (section === 'rules') {
        if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setCursor((c) => Math.min(filteredRules.length - 1, c + 1));
        if (input === 'a') {
          setEditingRuleId(null); setNewPattern(''); setNewType('name'); setNewMinAmount(''); setNewMaxAmount(''); setCatCursor(0); setAccountCursor(0);
          setRuleField('pattern'); setMode('rule-form');
        }
        if (input === 'x' && filteredRules[cursor]) { void handleDeleteRule(filteredRules[cursor].id); }
        if (key.return && filteredRules[cursor]) {
          const r = filteredRules[cursor];
          setEditingRuleId(r.id);
          setNewPattern(r.pattern);
          setNewType(r.match_type as 'name' | 'regex');
          setNewMinAmount(r.min_amount !== null ? String(r.min_amount) : '');
          setNewMaxAmount(r.max_amount !== null ? String(r.max_amount) : '');
          setCatCursor(Math.max(0, categories.indexOf(r.category)));
          setAccountCursor(accountCursorFor(r.account_id));
          setRuleField('pattern'); setMode('rule-form');
        }
      } else if (section === 'names') {
        if (key.upArrow) setNameCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setNameCursor((c) => Math.min(filteredNameRules.length - 1, c + 1));
        if (input === 'a') {
          setEditingNameRuleId(null); setNewNamePattern(''); setNewNameType('name'); setNewNameMinAmount(''); setNewNameMaxAmount(''); setNewReplacement(''); setAccountCursor(0);
          setNameRuleField('pattern'); setMode('name-rule-form');
        }
        if (input === 'x' && filteredNameRules[nameCursor]) { handleDeleteNameRule(filteredNameRules[nameCursor].id); }
        if (key.return && filteredNameRules[nameCursor]) {
          const r = filteredNameRules[nameCursor];
          setEditingNameRuleId(r.id);
          setNewNamePattern(r.pattern);
          setNewNameType(r.match_type as 'name' | 'regex');
          setNewNameMinAmount(r.min_amount !== null ? String(r.min_amount) : '');
          setNewNameMaxAmount(r.max_amount !== null ? String(r.max_amount) : '');
          setNewReplacement(r.replacement);
          setAccountCursor(accountCursorFor(r.account_id));
          setNameRuleField('pattern'); setMode('name-rule-form');
        }
      } else if (section === 'tags') {
        if (key.upArrow) setTagRuleCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setTagRuleCursor((c) => Math.min(filteredTagRules.length - 1, c + 1));
        if (input === 'a') {
          setEditingTagRuleId(null); setNewTagType('all'); setNewTagPattern(''); setNewTagMinAmount(''); setNewTagMaxAmount('');
          setTagPickCursor(0); setAccountCursor(0); setTagMatchCount(0);
          setTagRuleField('type'); setMode('tag-rule-form');
        }
        if (input === 'x' && filteredTagRules[tagRuleCursor]) { handleDeleteTagRule(filteredTagRules[tagRuleCursor].id); }
        if (key.return && filteredTagRules[tagRuleCursor]) {
          const r = filteredTagRules[tagRuleCursor];
          setEditingTagRuleId(r.id);
          setNewTagType(r.match_type as TagMatchType);
          setNewTagPattern(r.pattern);
          setNewTagMinAmount(r.min_amount !== null ? String(r.min_amount) : '');
          setNewTagMaxAmount(r.max_amount !== null ? String(r.max_amount) : '');
          setTagPickCursor(Math.max(0, tagOptions.findIndex((t) => t.id === r.tag_id)));
          setAccountCursor(accountCursorFor(r.account_id));
          setTagRuleField('type'); setMode('tag-rule-form');
        }
      } else if (section === 'categories') {
        if (key.upArrow) setCatListCursor((c) => Math.max(0, c - 1));
        if (key.downArrow) setCatListCursor((c) => Math.min(categories.length - 1, c + 1));
        if (input === 'a') { setNewCategoryName(''); setMode('add-category-name'); return; }
        if (input === 'v' && categories[catListCursor]) {
          const cat = categories[catListCursor];
          const nowHidden = !hiddenSet.has(cat);
          toggleHiddenCategory(cat, hiddenSet);
          void getHiddenCategorySet().then(setHiddenSet);
          showStatus(`${cat} is now ${nowHidden ? 'hidden' : 'visible'}`);
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
        if (input === 'x' && categories[catListCursor]) {
          const name = categories[catListCursor];
          deleteCategory(name);
          showStatus(`Deleted "${name}"`);
          load();
          setCatListCursor((c) => Math.max(0, c - 1));
        }
        if (key.return && catDetails[catListCursor]) {
          setRenameCatInput(categories[catListCursor] ?? '');
          setCatEditField('name');
          setMode('edit-category');
          return;
        }
      }
    } else if (mode === 'edit-category') {
      const CAT_FIELDS: CatEditField[] = ['name', 'flexibility', 'hidden'];
      if (key.escape) { setMode('list'); return; }
      if (key.return) {
        const cat = catDetails[catListCursor];
        if (cat) {
          const trimmed = renameCatInput.trim();
          if (trimmed && trimmed !== cat.name) {
            renameCategory(cat.name, trimmed);
            showStatus(`Renamed to "${trimmed}"`);
            load();
          }
        }
        setMode('list');
        return;
      }
      if (key.upArrow) { setCatEditField((f) => CAT_FIELDS[Math.max(0, CAT_FIELDS.indexOf(f) - 1)]); return; }
      if (key.downArrow) { setCatEditField((f) => CAT_FIELDS[Math.min(CAT_FIELDS.length - 1, CAT_FIELDS.indexOf(f) + 1)]); return; }
      if (catEditField === 'name') {
        if (key.backspace || key.delete) { setRenameCatInput((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setRenameCatInput((p) => p + input); return; }
        return;
      }
      if (catEditField === 'flexibility' && (key.leftArrow || key.rightArrow)) {
        const cat = catDetails[catListCursor];
        if (cat) {
          const idx = FLEX_CYCLE.indexOf(cat.flexibility);
          const dir = key.leftArrow ? -1 : 1;
          const next = FLEX_CYCLE[(idx + dir + FLEX_CYCLE.length) % FLEX_CYCLE.length];
          setCategoryFlexibility(cat.name, next);
          load();
        }
        return;
      }
      if (catEditField === 'hidden' && (input === ' ' || key.leftArrow || key.rightArrow)) {
        const cat = catDetails[catListCursor];
        if (cat) {
          toggleHiddenCategory(cat.name, hiddenSet);
          void getHiddenCategorySet().then(setHiddenSet);
        }
        return;
      }
    } else if (mode === 'rule-form') {
      if (key.escape) { setEditingRuleId(null); setMode('list'); return; }
      if (key.return) { if (newPattern.trim()) { void saveRule(); } return; }
      if (key.upArrow) { setRuleField((f) => RULE_FIELDS[Math.max(0, RULE_FIELDS.indexOf(f) - 1)]); return; }
      if (key.downArrow) { setRuleField((f) => RULE_FIELDS[Math.min(RULE_FIELDS.length - 1, RULE_FIELDS.indexOf(f) + 1)]); return; }
      if (ruleField === 'pattern') {
        if (key.backspace || key.delete) { setNewPattern((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewPattern((p) => p + input); return; }
      } else if (ruleField === 'type') {
        if (key.leftArrow || key.rightArrow) { setNewType((t) => t === 'name' ? 'regex' : 'name'); return; }
      } else if (ruleField === 'min') {
        if (key.backspace || key.delete) { setNewMinAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewMinAmount((p) => p + input); return; }
      } else if (ruleField === 'max') {
        if (key.backspace || key.delete) { setNewMaxAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewMaxAmount((p) => p + input); return; }
      } else if (ruleField === 'category') {
        if (key.leftArrow) { setCatCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setCatCursor((c) => Math.min(categories.length - 1, c + 1)); return; }
      } else if (ruleField === 'account') {
        if (key.leftArrow) { setAccountCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setAccountCursor((c) => Math.min(accountOptions.length - 1, c + 1)); return; }
      }
    } else if (mode === 'name-rule-form') {
      if (key.escape) { setEditingNameRuleId(null); setMode('list'); return; }
      if (key.return) { if (newNamePattern.trim() && newReplacement.trim()) { void handleSaveNameRule(); } return; }
      if (key.upArrow) { setNameRuleField((f) => NAME_RULE_FIELDS[Math.max(0, NAME_RULE_FIELDS.indexOf(f) - 1)]); return; }
      if (key.downArrow) { setNameRuleField((f) => NAME_RULE_FIELDS[Math.min(NAME_RULE_FIELDS.length - 1, NAME_RULE_FIELDS.indexOf(f) + 1)]); return; }
      if (nameRuleField === 'pattern') {
        if (key.backspace || key.delete) { setNewNamePattern((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewNamePattern((p) => p + input); return; }
      } else if (nameRuleField === 'type') {
        if (key.leftArrow || key.rightArrow) { setNewNameType((t) => t === 'name' ? 'regex' : 'name'); return; }
      } else if (nameRuleField === 'min') {
        if (key.backspace || key.delete) { setNewNameMinAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewNameMinAmount((p) => p + input); return; }
      } else if (nameRuleField === 'max') {
        if (key.backspace || key.delete) { setNewNameMaxAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewNameMaxAmount((p) => p + input); return; }
      } else if (nameRuleField === 'replacement') {
        if (key.backspace || key.delete) { setNewReplacement((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewReplacement((p) => p + input); return; }
      } else if (nameRuleField === 'account') {
        if (key.leftArrow) { setAccountCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setAccountCursor((c) => Math.min(accountOptions.length - 1, c + 1)); return; }
      }
    } else if (mode === 'tag-rule-form') {
      if (key.escape) { setEditingTagRuleId(null); setMode('list'); return; }
      if (key.return) { if (newTagType === 'all' || newTagPattern.trim()) { void saveTagRuleForm(); } return; }
      if (key.upArrow) { setTagRuleField((f) => tagRuleFields[Math.max(0, tagRuleFields.indexOf(f) - 1)]); return; }
      if (key.downArrow) { setTagRuleField((f) => tagRuleFields[Math.min(tagRuleFields.length - 1, tagRuleFields.indexOf(f) + 1)]); return; }
      if (tagRuleField === 'type') {
        if (key.leftArrow || key.rightArrow) {
          const dir = key.leftArrow ? -1 : 1;
          setNewTagType((t) => TAG_MATCH_TYPES[(TAG_MATCH_TYPES.indexOf(t) + dir + TAG_MATCH_TYPES.length) % TAG_MATCH_TYPES.length]);
          return;
        }
      } else if (tagRuleField === 'pattern') {
        if (key.backspace || key.delete) { setNewTagPattern((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewTagPattern((p) => p + input); return; }
      } else if (tagRuleField === 'min') {
        if (key.backspace || key.delete) { setNewTagMinAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewTagMinAmount((p) => p + input); return; }
      } else if (tagRuleField === 'max') {
        if (key.backspace || key.delete) { setNewTagMaxAmount((p) => p.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setNewTagMaxAmount((p) => p + input); return; }
      } else if (tagRuleField === 'tag') {
        if (key.leftArrow) { setTagPickCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setTagPickCursor((c) => Math.min(tagOptions.length - 1, c + 1)); return; }
      } else if (tagRuleField === 'account') {
        if (key.leftArrow) { setAccountCursor((c) => Math.max(0, c - 1)); return; }
        if (key.rightArrow) { setAccountCursor((c) => Math.min(accountOptions.length - 1, c + 1)); return; }
      }
    } else if (mode === 'add-category-name') {
      if (key.escape) { setMode('list'); return; }
      if (key.return && newCategoryName.trim()) {
        createCategory(newCategoryName.trim());
        showStatus(`Added "${newCategoryName.trim()}"`);
        setNewCategoryName('');
        setMode('list');
        load();
        return;
      }
      if (key.backspace || key.delete) { setNewCategoryName((p) => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setNewCategoryName((p) => p + input);
    }
  }, { isActive: isActive !== false });

  const q = search.toLowerCase();
  const filteredRules = q
    ? rules.filter((r) => r.pattern.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
    : rules;
  const filteredNameRules = q
    ? nameRules.filter((r) => r.pattern.toLowerCase().includes(q) || r.replacement.toLowerCase().includes(q))
    : nameRules;
  const filteredTagRules = q
    ? tagRules.filter((r) => r.pattern.toLowerCase().includes(q) || r.tag_name.toLowerCase().includes(q))
    : tagRules;

  const PAGE = 20;
  const { visible } = usePagination(filteredRules, cursor, PAGE);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="rules" showHints={showHints} />
      <Box marginTop={1}>
        <Box gap={3}>
          {SECTIONS.map((s) => (
            <Text key={s} bold color={section === s ? C_ACCENT : undefined} dimColor={section !== s}>
              {s === 'rules' ? 'Category Rules' : s === 'names' ? 'Name Rules' : s === 'tags' ? 'Tag Rules' : 'Categories'}
            </Text>
          ))}
        </Box>
      </Box>
      <Text dimColor>
        {section === 'categories'
          ? (showHints ? '[a] add  [x] delete  ·  Enter edit  ·  [Tab] switch' : '')
          : (showHints ? '[/] search  [a] add  [x] delete  ·  Enter edit  ·  [Tab] switch' : '[/] search')}
      </Text>

      {mode === 'search' ? (
        <SearchBar value={search} hint="Esc clear" />
      ) : search ? (
        <Box marginTop={1} gap={1}>
          <Text color={C_WARNING}>"{search}"</Text>
          <Text dimColor>· Esc to clear</Text>
        </Box>
      ) : null}
      <Box marginTop={1}><Divider /></Box>

      {section === 'rules' && (
        <>
          <ColumnHeader hasCursor columns={[
            { label: 'TYPE', width: 5 },
            { label: 'PATTERN', width: rulePatW },
            { label: 'AMOUNT', width: 10 },
            { label: 'CATEGORY', width: ruleCatW },
            { label: 'PRI' },
          ]} />
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
              <SelectableRow key={rule.id} selected={isSelected}>
                <Text color={C_WARNING} dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                <Text dimColor={!isSelected}>
                  {rule.pattern.length > rulePatW ? rule.pattern.slice(0, rulePatW - 1) + '…' : rule.pattern.padEnd(rulePatW)}
                </Text>
                {amtLabel ? <Text color={C_MANUAL} dimColor={!isSelected}>{truncate(amtLabel, 10).padEnd(10)}</Text> : <Text>{' '.repeat(10)}</Text>}
                <Text color={C_ACCENT} dimColor={!isSelected}>{rule.category.length > ruleCatW ? rule.category.slice(0, ruleCatW - 1) + '…' : rule.category.padEnd(ruleCatW)}</Text>
                <Text dimColor>{rule.priority}</Text>
                {rule.account_id && <Text color={C_MANUAL} dimColor={!isSelected}>@{accountLabel(rule.account_id)}</Text>}
              </SelectableRow>
            );
          })}
          <Divider />
          <Box gap={4}>
            <Text dimColor>{filteredRules.length}{search ? `/${rules.length}` : ''} rules</Text>
            {uncategorized > 0 && <Text color={C_WARNING}>{uncategorized} uncategorized transactions</Text>}
          </Box>
        </>
      )}

      {section === 'names' && (
        <>
          <ColumnHeader hasCursor columns={[
            { label: 'TYPE', width: 5 },
            { label: 'PATTERN', width: namePatW },
            { label: 'AMOUNT', width: 12 },
            { label: 'REPLACEMENT' },
          ]} />
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
                  <SelectableRow key={rule.id} selected={isSelected}>
                    <Text color={C_WARNING} dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                    <Text dimColor={!isSelected}>
                      {rule.pattern.length > namePatW ? rule.pattern.slice(0, namePatW - 1) + '…' : rule.pattern.padEnd(namePatW)}
                    </Text>
                    {amtLabel
                      ? <Text color={C_MANUAL} dimColor={!isSelected}>{truncate(amtLabel, 12).padEnd(12)}</Text>
                      : <Text>{' '.repeat(12)}</Text>}
                    <Text color={C_POSITIVE} dimColor={!isSelected}>{rule.replacement.length > nameReplW ? rule.replacement.slice(0, nameReplW - 1) + '…' : rule.replacement}</Text>
                    {rule.account_id && <Text color={C_MANUAL} dimColor={!isSelected}>@{accountLabel(rule.account_id)}</Text>}
                  </SelectableRow>
                );
              })}
          <Divider />
          <Text dimColor>{filteredNameRules.length}{search ? `/${nameRules.length}` : ''} name rule{nameRules.length !== 1 ? 's' : ''}</Text>
        </>
      )}

      {section === 'tags' && (
        <>
          <ColumnHeader hasCursor columns={[
            { label: 'TYPE', width: 5 },
            { label: 'PATTERN', width: rulePatW },
            { label: 'AMOUNT', width: 10 },
            { label: 'TAG', width: ruleCatW },
          ]} />
          {filteredTagRules.length === 0
            ? <Box marginTop={1}><Text dimColor>{tagRules.length === 0 ? 'No tag rules yet. [a] to add one (type "all" + an account tags everything in it).' : 'No matches.'}</Text></Box>
            : filteredTagRules.map((rule, i) => {
                const isSelected = tagRuleCursor === i;
                const amtLabel = rule.min_amount !== null && rule.max_amount !== null && rule.min_amount === rule.max_amount
                  ? `$${rule.min_amount}`
                  : rule.min_amount !== null && rule.max_amount !== null
                  ? `$${rule.min_amount}-$${rule.max_amount}`
                  : rule.min_amount !== null ? `≥$${rule.min_amount}`
                  : rule.max_amount !== null ? `≤$${rule.max_amount}`
                  : '';
                const patLabel = rule.match_type === 'all' ? '— all —' : rule.pattern;
                return (
                  <SelectableRow key={rule.id} selected={isSelected}>
                    <Text color={C_WARNING} dimColor={!isSelected}>{rule.match_type.padEnd(5)}</Text>
                    <Text dimColor={rule.match_type === 'all' || !isSelected}>
                      {patLabel.length > rulePatW ? patLabel.slice(0, rulePatW - 1) + '…' : patLabel.padEnd(rulePatW)}
                    </Text>
                    {amtLabel ? <Text color={C_MANUAL} dimColor={!isSelected}>{truncate(amtLabel, 10).padEnd(10)}</Text> : <Text>{' '.repeat(10)}</Text>}
                    <Text color={C_ACCENT} dimColor={!isSelected}>{rule.tag_name.length > ruleCatW ? rule.tag_name.slice(0, ruleCatW - 1) + '…' : rule.tag_name.padEnd(ruleCatW)}</Text>
                    {rule.account_id && <Text color={C_MANUAL} dimColor={!isSelected}>@{accountLabel(rule.account_id)}</Text>}
                  </SelectableRow>
                );
              })}
          <Divider />
          <Text dimColor>{filteredTagRules.length}{search ? `/${tagRules.length}` : ''} tag rule{tagRules.length !== 1 ? 's' : ''}</Text>
        </>
      )}

      {section === 'categories' && (
        <>
          <ColumnHeader hasCursor marginTop={0} columns={[
            { label: 'NAME', width: catNameW },
            { label: 'FLEXIBILITY', width: 14 },
            { label: 'HIDDEN' },
          ]} />
          <Box flexDirection="column">
            {catDetails.map((cat, i) => {
              const isSelected = catListCursor === i;
              const isHidden = hiddenSet.has(cat.name);
              const flexColor = cat.flexibility ? FLEX_COLORS[cat.flexibility] : undefined;
              return (
                <SelectableRow key={cat.name} selected={isSelected}>
                  <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>{cat.name.length > catNameW ? cat.name.slice(0, catNameW - 1) + '…' : cat.name.padEnd(catNameW)}</Text>
                  {cat.flexibility
                    ? <Text color={flexColor} dimColor={!isSelected}>{cat.flexibility.padEnd(14)}</Text>
                    : <Text dimColor>{'—'.padEnd(14)}</Text>}
                  {isHidden
                    ? <Text color={C_WARNING} dimColor={!isSelected}>hidden</Text>
                    : <Text dimColor>—</Text>}
                </SelectableRow>
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

      {statusMsg && <Text color={C_POSITIVE} bold>{statusMsg}</Text>}

      {mode === 'edit-category' && catDetails[catListCursor] && (() => {
        const cat = catDetails[catListCursor];
        const isHidden = hiddenSet.has(cat.name);
        const flexColor = cat.flexibility ? FLEX_COLORS[cat.flexibility] : undefined;
        return (
          <ModalPanel title={`Edit: ${cat.name}`}>
            <Box marginTop={1} flexDirection="column" gap={1}>
              <EditTextField label="Name" active={catEditField === 'name'} value={renameCatInput} color={C_WARNING} emptyText="—" />
              <EditToggleField label="Flexibility" active={catEditField === 'flexibility'} value={cat.flexibility ?? '—'} valueColor={flexColor ?? C_DIM} />
              <Box gap={2}>
                <Text color={catEditField === 'hidden' ? C_ACCENT : C_NEUTRAL}>{'Hidden'.padEnd(12)}</Text>
                <Text color={catEditField === 'hidden' ? C_ACCENT : (isHidden ? C_WARNING : C_DIM)}>
                  {isHidden ? 'yes' : 'no'}{'  (space to toggle)'}
                </Text>
              </Box>
            </Box>
            <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
          </ModalPanel>
        );
      })()}

      {mode === 'rule-form' && (
        <ModalPanel title={`${editingRuleId !== null ? 'Edit' : 'New'} Category Rule`}>
          <Box marginTop={1} flexDirection="column" gap={1}>
            <EditTextField label="Pattern" active={ruleField === 'pattern'} value={newPattern} color={C_WARNING} placeholder="keyword or /regex/" emptyText="empty" />
            <EditToggleField label="Match type" active={ruleField === 'type'} value={newType} />
            <EditTextField label="Min $" active={ruleField === 'min'} value={newMinAmount} color={C_WARNING} placeholder="optional" />
            <EditTextField label="Max $" active={ruleField === 'max'} value={newMaxAmount} color={C_WARNING} placeholder="optional" />
            <EditToggleField label="Category" active={ruleField === 'category'} value={categories[catCursor] ?? '—'} />
            <EditToggleField label="Account" active={ruleField === 'account'} value={accountLabel(accountOptions[accountCursor] ?? null)} />
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
        </ModalPanel>
      )}

      {mode === 'name-rule-form' && (
        <ModalPanel title={`${editingNameRuleId !== null ? 'Edit' : 'New'} Name Rule`} borderColor={C_POSITIVE}>
          <Box marginTop={1} flexDirection="column" gap={1}>
            <EditTextField label="Pattern" active={nameRuleField === 'pattern'} value={newNamePattern} color={C_WARNING} placeholder="keyword or /regex/" emptyText="empty" />
            <EditToggleField label="Match type" active={nameRuleField === 'type'} value={newNameType} />
            <EditTextField label="Min $" active={nameRuleField === 'min'} value={newNameMinAmount} color={C_WARNING} placeholder="optional" />
            <EditTextField label="Max $" active={nameRuleField === 'max'} value={newNameMaxAmount} color={C_WARNING} placeholder="optional" />
            <EditTextField label="Replace with" active={nameRuleField === 'replacement'} value={newReplacement} color={C_POSITIVE} placeholder="display name" emptyText="empty" />
            <EditToggleField label="Account" active={nameRuleField === 'account'} value={accountLabel(accountOptions[accountCursor] ?? null)} />
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
        </ModalPanel>
      )}

      {mode === 'tag-rule-form' && (
        <ModalPanel title={`${editingTagRuleId !== null ? 'Edit' : 'New'} Tag Rule`} borderColor={C_ACCENT}>
          <Box marginTop={1} flexDirection="column" gap={1}>
            <EditToggleField label="Match type" active={tagRuleField === 'type'} value={newTagType} />
            {newTagType !== 'all' && (
              <EditTextField label="Pattern" active={tagRuleField === 'pattern'} value={newTagPattern} color={C_WARNING} placeholder="keyword or /regex/" emptyText="empty" />
            )}
            <EditTextField label="Min $" active={tagRuleField === 'min'} value={newTagMinAmount} color={C_WARNING} placeholder="optional" />
            <EditTextField label="Max $" active={tagRuleField === 'max'} value={newTagMaxAmount} color={C_WARNING} placeholder="optional" />
            <EditToggleField label="Tag" active={tagRuleField === 'tag'} value={tagOptions[tagPickCursor]?.name ?? '— no tags —'} />
            <EditToggleField label="Account" active={tagRuleField === 'account'} value={accountLabel(accountOptions[accountCursor] ?? null)} />
          </Box>
          <Box marginTop={1}>
            <Text color={C_WARNING}>{tagMatchCount} transactions match</Text>
            <Text dimColor> · saving tags them (removed tags stay removed)</Text>
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ field  ·  ← → change  ·  Enter save  ·  Esc cancel</Text></Box>
        </ModalPanel>
      )}

      {mode === 'add-category-name' && (
        <ModalPanel title="New Category" borderColor={C_WARNING}>
          <Text dimColor>Type a name · Enter save · Esc cancel</Text>
          <Box marginTop={1} gap={1}><Text>Name: </Text><TextInput value={newCategoryName} color={C_WARNING} /></Box>
        </ModalPanel>
      )}
    </Box>
  );
}
