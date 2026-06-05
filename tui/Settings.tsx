import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { loadProfile, saveProfile, type Profile } from '../core/profile.js';
import { C_ACCENT, C_NEUTRAL, CURSOR } from './ui.js';
import { PageHeader, SectionHeader, SelectableRow } from './components/index.js';
import { Divider } from './fmt.js';
import { useSetTyping } from './TypingContext.js';

const LABEL_W = 16;
const VALUE_W = 18;

type FieldRow = { kind: 'field'; id: string; label: string; value: string; numeric?: boolean };
type ActionRow = { kind: 'action'; id: string; label: string };
type SettingsRow = FieldRow | ActionRow;

function buildRows(profile: Profile): SettingsRow[] {
  const r: SettingsRow[] = [
    { kind: 'field', id: 'self-name', label: 'Your name', value: profile.self.name },
    { kind: 'field', id: 'self-year', label: 'Birth year', value: profile.self.birthYear > 0 ? String(profile.self.birthYear) : '', numeric: true },
  ];
  if (profile.spouse) {
    r.push(
      { kind: 'field', id: 'spouse-name', label: 'Spouse name', value: profile.spouse.name },
      { kind: 'field', id: 'spouse-year', label: 'Spouse year', value: profile.spouse.birthYear > 0 ? String(profile.spouse.birthYear) : '', numeric: true },
    );
  } else {
    r.push({ kind: 'action', id: 'add-spouse', label: '[a] Add spouse' });
  }
  for (let i = 0; i < profile.children.length; i++) {
    const child = profile.children[i];
    r.push(
      { kind: 'field', id: `child-${i}-name`, label: `Child ${i + 1}`, value: child.name },
      { kind: 'field', id: `child-${i}-year`, label: `  birth year`, value: child.birthYear > 0 ? String(child.birthYear) : '', numeric: true },
    );
  }
  r.push({ kind: 'action', id: 'add-child', label: '[a] Add child' });
  return r;
}

export function Settings({ onNavigate, isActive, showHints }: {
  onNavigate: (s: Screen) => void;
  isActive?: boolean;
  showHints: boolean;
}) {
  const setTyping = useSetTyping();
  const [profile, setProfile] = useState<Profile>(
    () => loadProfile() ?? { self: { name: '', birthYear: 0 }, children: [] }
  );
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  useEffect(() => { setTyping(editing); }, [editing, setTyping]);

  const rows = useMemo(() => buildRows(profile), [profile]);
  const clampedCursor = Math.min(cursor, rows.length - 1);
  const currentRow = rows[clampedCursor] as SettingsRow | undefined;

  function persist(next: Profile) {
    setProfile(next);
    saveProfile(next);
  }

  function commitEdit() {
    if (!currentRow || currentRow.kind !== 'field') return;
    const row = currentRow as FieldRow;
    const value = editBuffer.trim();
    const next: Profile = { ...profile, children: [...profile.children] };

    if (row.id === 'self-name') {
      next.self = { ...next.self, name: value };
    } else if (row.id === 'self-year') {
      const y = parseInt(value);
      if (value && !isNaN(y) && y >= 1900 && y <= 2025) next.self = { ...next.self, birthYear: y };
    } else if (row.id === 'spouse-name' && next.spouse) {
      next.spouse = { ...next.spouse, name: value };
    } else if (row.id === 'spouse-year' && next.spouse) {
      const y = parseInt(value);
      if (value && !isNaN(y) && y >= 1900 && y <= 2025) next.spouse = { ...next.spouse, birthYear: y };
    } else {
      const m = row.id.match(/^child-(\d+)-(name|year)$/);
      if (m) {
        const idx = parseInt(m[1]);
        const field = m[2];
        const child = { ...next.children[idx] };
        if (field === 'name') {
          child.name = value;
        } else {
          const y = parseInt(value);
          if (value && !isNaN(y) && y >= 1900 && y <= 2025) child.birthYear = y;
        }
        next.children = [...next.children.slice(0, idx), child, ...next.children.slice(idx + 1)];
      }
    }
    persist(next);
    setEditing(false);
    setEditBuffer('');
  }

  function getChildIdx(id: string): number | null {
    const m = id.match(/^child-(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  useInput((input, key) => {
    if (editing) {
      if (key.escape) { setEditing(false); setEditBuffer(''); return; }
      if (key.return) { commitEdit(); return; }
      if (key.backspace || key.delete) { setEditBuffer((b) => b.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) {
        if ((currentRow as FieldRow)?.numeric) {
          const maxLen = 4;
          if (/^\d$/.test(input) && editBuffer.length < maxLen) setEditBuffer((b) => b + input);
        } else {
          setEditBuffer((b) => b + input);
        }
      }
      return;
    }

    if (key.escape) { onNavigate('dashboard'); return; }
    if (handleNavKey(input, 'settings', onNavigate)) return;
    if (key.upArrow)   { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }

    if (key.return) {
      if (!currentRow) return;
      if (currentRow.kind === 'field') {
        setEditBuffer((currentRow as FieldRow).value);
        setEditing(true);
      } else if (currentRow.id === 'add-spouse') {
        persist({ ...profile, spouse: { name: '', birthYear: 0 } });
      } else if (currentRow.id === 'add-child') {
        persist({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] });
      }
      return;
    }

    if (input === 'a') {
      if (!profile.spouse) {
        persist({ ...profile, spouse: { name: '', birthYear: 0 } });
      } else {
        persist({ ...profile, children: [...profile.children, { name: '', birthYear: 0 }] });
      }
      return;
    }

    if (input === 'd' && currentRow) {
      if (currentRow.id === 'spouse-name' || currentRow.id === 'spouse-year') {
        const { spouse: _, ...rest } = profile;
        persist({ ...rest, children: [...profile.children] } as Profile);
        return;
      }
      const idx = getChildIdx(currentRow.id);
      if (idx !== null) {
        persist({ ...profile, children: profile.children.filter((_, i) => i !== idx) });
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
    }
  }, { isActive: isActive !== false });

  function renderField(row: SettingsRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    const isEditingThis = isSelected && editing;
    const field = row as FieldRow;
    const displayValue = isEditingThis ? editBuffer : field.value;
    const hint = isEditingThis
      ? 'Enter confirm  ·  Esc cancel'
      : isSelected
        ? field.id.includes('spouse') ? 'Enter to edit  ·  [d] remove spouse'
          : field.id.includes('child') ? `Enter to edit  ·  [d] remove`
          : 'Enter to edit'
        : '';
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined}>{field.label.padEnd(LABEL_W)}</Text>
        <Box>
          <Text color={isSelected ? C_ACCENT : C_NEUTRAL}>{displayValue.padStart(VALUE_W)}</Text>
          {isEditingThis && <Text color={C_ACCENT}>{CURSOR}</Text>}
        </Box>
        <Text dimColor>{hint}</Text>
      </SelectableRow>
    );
  }

  function renderAction(row: SettingsRow, sectionCursor: number) {
    const isSelected = sectionCursor === clampedCursor;
    return (
      <SelectableRow key={row.id} selected={isSelected} gap={2}>
        <Text color={isSelected ? C_ACCENT : undefined} dimColor={!isSelected}>{(row as ActionRow).label}</Text>
      </SelectableRow>
    );
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="settings" showHints={showHints} />
      <Box marginTop={1}><Text bold>Settings</Text></Box>
      {showHints && <Text dimColor>↑↓ navigate  ·  Enter edit  ·  [a] add  ·  [d] remove  ·  Esc back</Text>}
      <Divider />

      {/* Household section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>HOUSEHOLD</SectionHeader>
        {rows[0] && renderField(rows[0], 0)}
        {rows[1] && renderField(rows[1], 1)}
      </Box>

      {/* Spouse section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>SPOUSE</SectionHeader>
        {profile.spouse
          ? (
            <>
              {rows[2] && rows[2].id === 'spouse-name' && renderField(rows[2], 2)}
              {rows[3] && rows[3].id === 'spouse-year' && renderField(rows[3], 3)}
            </>
          ) : (
            rows[2] && rows[2].id === 'add-spouse' && renderAction(rows[2], 2)
          )
        }
      </Box>

      {/* Children section */}
      <Box flexDirection="column" marginTop={1}>
        <SectionHeader>CHILDREN</SectionHeader>
        {profile.children.length === 0 && <Box marginTop={1}><Text dimColor>No children added.</Text></Box>}
        {rows.map((row, i) => {
          if (row.id === 'add-child') return renderAction(row, i);
          if (/^child-\d+-(name|year)$/.test(row.id)) return renderField(row, i);
          return null;
        })}
      </Box>

    </Box>
  );
}
