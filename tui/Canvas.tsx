import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { C_POSITIVE, C_NEGATIVE, C_NEUTRAL, C_ACCENT } from './ui.js';
import { PageHeader, SectionHeader, DialRow, SearchBar, SelectableRow, TruncatedText } from './components/index.js';
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

// Toggle flips between 0/1 regardless of direction — matches Settings.tsx's
// backup-include-key toggle, where ← and → both flip the boolean.
function toggleFlip(val: number): number {
  return val !== 0 ? 0 : 1;
}

// Select cycles through the 0-based index of `dial.options` with wraparound —
// matches Settings.tsx's theme cycler.
function selectStep(dial: DialDef, dir: 1 | -1, val: number): number {
  const n = dial.options?.length ?? 0;
  if (n === 0) return val;
  const idx = Math.round(val);
  return ((idx + dir) % n + n) % n;
}

function stepDialValue(dial: DialDef, dir: 1 | -1, val: number): number {
  if (dial.format === 'toggle') return toggleFlip(val);
  if (dial.format === 'select') return selectStep(dial, dir, val);
  return dialStep(dial, dir, val);
}

// ─── CanvasView — testable rendering of a CanvasSpec ─────────────────────────

export function CanvasView({ spec, isActive }: { spec: CanvasSpec; isActive?: boolean }) {
  // Unconditional — every dial in the spec, visible or not — so a hidden sub-dial's
  // value is seeded once at load and survives being hidden and reshown later
  // (freeze semantics, not reset-on-hide).
  const allDials = spec.elements.flatMap((el) => el.type === 'dial' ? [el.dial] : []);
  const [dialValues, setDialValues] = useState<Record<string, number>>(() => {
    const d: Record<string, number> = {};
    allDials.forEach((dl) => { d[dl.key] = dl.default; });
    return d;
  });

  // Visibility-filtered — recomputed every render since `visible` expressions read
  // live dial values. Original spec index is kept as the React key so elements
  // above a toggled one don't get remounted when the list shrinks/grows.
  const visibleElements = spec.elements
    .map((el, originalIndex) => ({ el, originalIndex }))
    .filter(({ el }) => el.visible === undefined || evalExpr(el.visible, dialValues) !== 0);
  const visibleDials = visibleElements.flatMap(({ el }) => el.type === 'dial' ? [el.dial] : []);

  // Shared value-column width for this render: the widest formatted value across
  // every visible dial and output, floored at VALUE_W. Computed once here (rather
  // than per-row inside DialRow) so every row's `[ ... ]` box is exactly as wide as
  // the single widest value actually present — a $1,093,389.00 balance no longer
  // widens only its own row and knocks that row's closing bracket out of the column
  // every other row's bracket sits in. Short-valued canvases still get VALUE_W, the
  // original floor, so they don't get artificially wide boxes.
  const valueWidth = visibleElements.reduce((max, { el }) => {
    if (el.type === 'dial') {
      const val = dialValues[el.dial.key] ?? el.dial.default;
      return Math.max(max, fmtDialValue(val, el.dial.format, el.dial.options).length);
    }
    if (el.type === 'output') {
      const val = evalExpr(el.output.expr, dialValues);
      return Math.max(max, fmtValue(val, el.output.format, el.output.signed).length);
    }
    return max;
  }, VALUE_W);

  // Selection tracked by dial key, not index — the visible dial list's length can
  // change at runtime (toggling a parent hides/reveals a sub-dial), so a raw index
  // would silently point at the wrong row. Render index is derived via findIndex();
  // if the previously-selected dial just became hidden, fall back to the first
  // visible dial.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => visibleDials[0]?.key);
  const rawIdx = visibleDials.findIndex((d) => d.key === selectedKey);
  const dialIdx = rawIdx >= 0 ? rawIdx : 0;
  const currentDial = visibleDials[dialIdx];
  const currentKey = currentDial?.key;

  const [editMode, setEditMode] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  function moveSelection(dir: 1 | -1) {
    if (visibleDials.length === 0) { setSelectedKey(undefined); return; }
    if (rawIdx === -1) { setSelectedKey(visibleDials[0].key); return; }
    const nextIdx = (rawIdx + dir + visibleDials.length) % visibleDials.length;
    setSelectedKey(visibleDials[nextIdx].key);
  }

  function applyEdit(buffer: string) {
    if (currentKey && currentDial) {
      const n = parseFloat(buffer);
      if (!isNaN(n)) {
        let val = n;
        if (currentDial.min !== undefined && val < currentDial.min) val = currentDial.min;
        if (currentDial.max !== undefined && val > currentDial.max) val = currentDial.max;
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
    if (key.upArrow)   { moveSelection(-1); return; }
    if (key.downArrow) { moveSelection(1); return; }
    if (key.return && currentKey && currentDial && currentDial.format !== 'toggle' && currentDial.format !== 'select') {
      setEditBuffer(String(dialValues[currentKey] ?? currentDial.default));
      setEditMode(true);
      return;
    }
    if (key.rightArrow && currentKey && currentDial) {
      setDialValues((v) => ({ ...v, [currentKey]: stepDialValue(currentDial, 1,  v[currentKey] ?? currentDial.default) }));
    }
    if (key.leftArrow && currentKey && currentDial) {
      setDialValues((v) => ({ ...v, [currentKey]: stepDialValue(currentDial, -1, v[currentKey] ?? currentDial.default) }));
    }
    if (_input === 'r' && currentKey && currentDial) {
      setDialValues((v) => ({ ...v, [currentKey]: currentDial.default }));
    }
  }, { isActive: isActive !== false });

  return (
    <Box flexDirection="column">
      <Text bold>{spec.title}</Text>

      {visibleElements.map(({ el, originalIndex }) => {
        if (el.type === 'section') {
          return <Box key={originalIndex} marginTop={1}><SectionHeader>{el.label}</SectionHeader></Box>;
        }
        if (el.type === 'text') {
          return <Box key={originalIndex}><Text dimColor>{el.content}</Text></Box>;
        }
        if (el.type === 'dial') {
          const d = el.dial;
          const val = dialValues[d.key] ?? d.default;
          const isSelected = currentKey === d.key;
          const isEditingThis = isSelected && editMode;
          const atDefault = val === d.default;
          const resetHint = !atDefault ? '  ·  [r] reset' : '';
          const description = isEditingThis
            ? 'Enter confirm  ·  Esc cancel'
            : isSelected
              ? d.format === 'toggle'
                ? `← → toggle${resetHint}`
                : d.format === 'select'
                  ? `← → cycle${resetHint}`
                  : `← → ±${fmtDialValue(d.step, d.format)}${resetHint}`
              : `${d.hint}${!atDefault ? ' (modified)' : ''}`;
          return (
            <DialRow
              key={originalIndex}
              label={d.label}
              value={fmtDialValue(val, d.format, d.options)}
              selected={isSelected}
              labelWidth={LABEL_W}
              valueWidth={valueWidth}
              editing={isEditingThis}
              editBuffer={editBuffer}
              description={description}
            />
          );
        }
        if (el.type === 'output') {
          const out = el.output;
          const val = evalExpr(out.expr, dialValues);
          return (
            <SelectableRow key={originalIndex} selected={false} gap={2}>
              {/* Same truncate-not-wrap treatment as DialRow's label column — an
                  oversized output label must not wrap and misalign the value column. */}
              <TruncatedText width={LABEL_W} dimColor>{out.label}</TruncatedText>
              <Text bold color={outputColor(out.color)}>{fmtValue(val, out.format, out.signed).padStart(valueWidth)}</Text>
            </SelectableRow>
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
