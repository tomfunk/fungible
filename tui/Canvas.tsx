import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { C_POSITIVE, C_NEGATIVE, C_NEUTRAL, C_ACCENT } from './ui.js';
import { PageHeader, SectionHeader, DialRow, SearchBar, SelectableRow } from './components/index.js';
import { evalExpr, fmtValue, fmtDialValue, type CanvasSpec, type DialDef } from '../core/canvas-agent.js';
import { loadHistory, deleteHistoryEntry, type CanvasHistoryEntry } from '../core/canvas-history.js';
import { useRefreshKey } from './RefreshContext.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const LABEL_W = 18;
const VALUE_W = 12;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function outputColor(color: string | undefined): string | undefined {
  switch (color) {
    case 'positive': return C_POSITIVE;
    case 'negative': return C_NEGATIVE;
    case 'accent':   return C_ACCENT;
    default:         return C_NEUTRAL;
  }
}

function dialStep(dial: DialDef, dir: 1 | -1, val: number): number {
  const next = parseFloat((val + dir * dial.step).toFixed(10));
  if (dial.min !== undefined && next < dial.min) return dial.min;
  if (dial.max !== undefined && next > dial.max) return dial.max;
  return next;
}

// ─── CanvasView — testable rendering of a CanvasSpec ─────────────────────────

export function CanvasView({ spec, isActive }: { spec: CanvasSpec; isActive?: boolean }) {
  const dials = spec.elements.flatMap((el) => el.type === 'dial' ? [el.dial] : []);
  const [dialValues, setDialValues] = useState<Record<string, number>>(() => {
    const d: Record<string, number> = {};
    dials.forEach((dl) => { d[dl.key] = dl.default; });
    return d;
  });
  const [dialIdx, setDialIdx] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  const currentKey = dials[dialIdx]?.key;

  function applyEdit(buffer: string) {
    if (currentKey) {
      const n = parseFloat(buffer);
      if (!isNaN(n)) {
        const dial = dials[dialIdx];
        let val = n;
        if (dial.min !== undefined && val < dial.min) val = dial.min;
        if (dial.max !== undefined && val > dial.max) val = dial.max;
        setDialValues((v) => ({ ...v, [currentKey]: parseFloat(val.toFixed(10)) }));
      }
    }
    setEditMode(false);
    setEditBuffer('');
  }

  useInput((_input, key) => {
    if (editMode) {
      if (key.escape) { setEditMode(false); setEditBuffer(''); return; }
      if (key.return) { applyEdit(editBuffer); return; }
      if (key.backspace || key.delete) { setEditBuffer((b) => b.slice(0, -1)); return; }
      if (_input && /^[\d.\-]$/.test(_input) && !key.ctrl && !key.meta) setEditBuffer((b) => b + _input);
      return;
    }
    if (key.upArrow)   { setDialIdx((i) => (i - 1 + dials.length) % dials.length); return; }
    if (key.downArrow) { setDialIdx((i) => (i + 1) % dials.length); return; }
    if (key.return && currentKey) {
      setEditBuffer(String(dialValues[currentKey] ?? dials[dialIdx].default));
      setEditMode(true);
      return;
    }
    if (key.rightArrow && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dialStep(dials[dialIdx], 1,  v[currentKey] ?? dials[dialIdx].default) }));
    }
    if (key.leftArrow && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dialStep(dials[dialIdx], -1, v[currentKey] ?? dials[dialIdx].default) }));
    }
    if (_input === 'r' && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dials[dialIdx].default }));
    }
  }, { isActive: isActive !== false });

  return (
    <Box flexDirection="column">
      <Text bold>{spec.title}</Text>

      {spec.elements.map((el, i) => {
        if (el.type === 'section') {
          return <Box key={i} marginTop={1}><SectionHeader>{el.label}</SectionHeader></Box>;
        }
        if (el.type === 'text') {
          return <Box key={i}><Text dimColor>{el.content}</Text></Box>;
        }
        if (el.type === 'dial') {
          const d = el.dial;
          const val = dialValues[d.key] ?? d.default;
          const isSelected = dials[dialIdx]?.key === d.key;
          const isEditingThis = isSelected && editMode;
          const atDefault = val === d.default;
          return (
            <DialRow
              key={i}
              label={d.label}
              value={fmtDialValue(val, d.format)}
              selected={isSelected}
              labelWidth={LABEL_W}
              valueWidth={VALUE_W}
              editing={isEditingThis}
              editBuffer={editBuffer}
              description={isEditingThis
                ? 'Enter confirm  ·  Esc cancel'
                : isSelected
                  ? `← → ±${fmtDialValue(d.step, d.format)}${!atDefault ? '  ·  [r] reset' : ''}`
                  : `${d.hint}${!atDefault ? ' (modified)' : ''}`}
            />
          );
        }
        if (el.type === 'output') {
          const out = el.output;
          const val = evalExpr(out.expr, dialValues);
          return (
            <Box key={i} gap={3}>
              <Text dimColor>{out.label.padEnd(LABEL_W)}</Text>
              <Text bold color={outputColor(out.color)}>{fmtValue(val, out.format, out.signed).padStart(VALUE_W)}</Text>
            </Box>
          );
        }
        return null;
      })}
    </Box>
  );
}

// ─── Canvas screen ────────────────────────────────────────────────────────────

type Mode = 'view' | 'history';

export function Canvas({ onNavigate, onLoadSpec, isActive, showHints, spec, specKey }: {
  onNavigate: (s: Screen) => void;
  onLoadSpec: (spec: CanvasSpec) => void;
  isActive?: boolean;
  showHints: boolean;
  spec: CanvasSpec | null;
  specKey: number;
}) {
  const [mode, setMode]           = useState<Mode>('view');
  const [search, setSearch]       = useState('');
  const [history, setHistory]     = useState<CanvasHistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const refreshKey = useRefreshKey();

  const filtered = search
    ? history.filter((e) =>
        e.title.toLowerCase().includes(search.toLowerCase()) ||
        e.prompt.toLowerCase().includes(search.toLowerCase()))
    : history;

  useEffect(() => {
    if (mode === 'history') setHistory(loadHistory());
  }, [mode, refreshKey]);

  useEffect(() => { setHistoryIdx(0); }, [search]);

  useInput((input, key) => {
    if (mode === 'history') {
      if (key.escape)    { setMode('view'); setSearch(''); return; }
      if (key.upArrow)   { setHistoryIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setHistoryIdx((i) => Math.min(filtered.length - 1, i + 1)); return; }
      if (key.return && filtered[historyIdx]) {
        onLoadSpec(filtered[historyIdx].spec);
        setMode('view');
        setSearch('');
        return;
      }
      if (key.ctrl && input === 'd' && filtered[historyIdx]) {
        deleteHistoryEntry(filtered[historyIdx].id);
        const next = loadHistory();
        setHistory(next);
        setHistoryIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
        return;
      }
      if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) { setSearch((s) => s + input); return; }
      return;
    }

    // view mode
    if (key.escape) { onNavigate('dashboard'); return; }
    if (input === '/') { setMode('history'); setHistory(loadHistory()); return; }
    handleNavKey(input, 'canvas', onNavigate);
  }, { isActive: isActive !== false });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="canvas" showHints={showHints} />

      <Box marginTop={1}><Text bold>Canvas</Text></Box>
      {showHints && (
        <Text dimColor>
          {mode === 'history'
            ? '↑↓ select  ·  type to filter  ·  Enter load  ·  ctrl + d delete  ·  Esc back'
            : spec
              ? '↑↓ select  ·  ← → adjust  ·  Enter type  ·  [r] reset  ·  [/] history'
              : '[/] history  ·  or ask the agent (`)'}
        </Text>
      )}

      {mode === 'history' ? (
        <>
          <SearchBar value={search} hint="↑↓ select  Enter load  ctrl+d delete  Esc back" />
          <Box marginTop={1}><Divider /></Box>
          <Box flexDirection="column" marginTop={1}>
            {filtered.length === 0
              ? <Text dimColor>No canvases found.</Text>
              : filtered.map((e, i) => (
                  <SelectableRow key={e.id} selected={i === historyIdx} gap={2}>
                    <Text color={i === historyIdx ? C_ACCENT : undefined}>{e.title.padEnd(24)}</Text>
                    <Text dimColor>{e.prompt.length > 44 ? e.prompt.slice(0, 43) + '…' : e.prompt.padEnd(44)}</Text>
                    {(e.versions ?? 0) > 1 && <Text dimColor>v{e.versions}</Text>}
                    <Text dimColor>{(e.updatedAt ?? e.createdAt).slice(0, 10)}</Text>
                  </SelectableRow>
                ))
            }
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}><Divider /></Box>
          {spec
            ? <Box marginTop={1}><CanvasView key={specKey} spec={spec} isActive={isActive} /></Box>
            : <Box marginTop={1}><Text dimColor>Ask the agent (`) to generate a canvas — or press [/] to browse history.</Text></Box>
          }
        </>
      )}
    </Box>
  );
}
