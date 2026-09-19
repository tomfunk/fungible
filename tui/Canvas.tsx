import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { C_POSITIVE, C_NEGATIVE, C_NEUTRAL, C_ACCENT, CURSOR } from './ui.js';
import { PageHeader, SectionHeader, DialRow, SearchBar, SelectableRow, TruncatedText, ColumnHeader } from './components/index.js';
import { evalExpr, computeOutputValues, buildListScope, fmtValue, fmtDialValue, projectSeries, type CanvasSpec, type CanvasElement, type DialDef, type ListRowDef, type ProjectionDef, type ProjectionSeriesDef, type ProjectionPoint } from '../core/canvas-agent.js';
import { loadHistory, deleteHistoryEntry, updateHistoryEntrySpec, resolveAndWriteCanvasSpec, type CanvasHistoryEntry } from '../core/canvas-history.js';
import { useRefreshKey } from './RefreshContext.js';
import { bar, BAR_WIDTH } from './charUtils.js';

// A CanvasSpec as read from CANVAS_SPEC_PATH, or attached when loading one from
// history — carries the originating history entry's id so list-row edits (add/
// remove/edit-in-place) can be persisted back via core/canvas-history.ts. A spec
// with no `_historyId` (e.g. a hand-built or malformed navigation payload) simply
// can't persist row edits — they still work in-memory for the session, the same
// way an unresolvable binding just leaves a dial's default untouched rather than
// crashing.
export type LoadedCanvasSpec = CanvasSpec & { _historyId?: string };

// ─── Constants ────────────────────────────────────────────────────────────────

const LABEL_W = 18;
const VALUE_W = 12;
const LIST_LABEL_W = 18;
const LIST_START_W = 4;  // floor width, e.g. "2045" or "any"
const LIST_END_W = 7;    // floor width, e.g. "ongoing"

// A list row's start/end year cells step through this range before falling
// off the bounded end into "no bound" (see stepStartYear/stepEndYear below).
const MIN_ROW_YEAR = new Date().getFullYear() - 20;
const MAX_ROW_YEAR = new Date().getFullYear() + 50;

// One list row contributes exactly these 4 cursor stops, in this order.
const LIST_CELLS = ['label', 'amount', 'start', 'end'] as const;
type ListCell = typeof LIST_CELLS[number];

// Flattened top-level cursor stop — a dial, one cell of a list row, or (for an
// empty list) a placeholder to land on and add its first row. Keyed by a stable
// string id, never index: list length changes on every add/remove, exactly why
// dial selection is already tracked by `key` rather than a raw index.
type CursorStop =
  | { kind: 'dial'; key: string }
  | { kind: 'listCell'; key: string; listKey: string; rowId: string; cell: ListCell }
  | { kind: 'listAdd'; key: string; listKey: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function outputColor(color: string | undefined): string | undefined {
  switch (color) {
    case 'positive': return C_POSITIVE;
    case 'negative': return C_NEGATIVE;
    case 'accent':   return C_ACCENT;
    default:         return C_NEUTRAL;
  }
}

// A `chart`/`table` series' display color. A `signed` series (one that can cross
// zero — debt payoff, cash flow) is colored by the sign of its OWN value at this
// point rather than its declared `color`, matching Trends.tsx's search-view
// convention (searchIncomeOnly ? C_POSITIVE : C_NEGATIVE) for a bar whose meaning
// flips with sign. An unsigned series just uses outputColor() like an `output`
// element does.
function seriesColor(s: ProjectionSeriesDef, value: number): string | undefined {
  if (s.signed) return value >= 0 ? C_POSITIVE : C_NEGATIVE;
  return outputColor(s.color);
}

// Shared column-width computation for both `chart` and `table`: the driver's own
// column (formatted via fmtDialValue, using the driver dial's own format/options —
// never assumed to be 'year') plus one column per series (formatted via fmtValue).
// Each width is the max of its header label and every point's formatted cell,
// floored at 6 so a short label/value doesn't produce a cramped column — same
// spirit as LABEL_W/VALUE_W above, just computed per-projection instead of
// per-canvas since a chart/table's columns don't share the dial/output value
// column.
const PROJECTION_COL_FLOOR = 6;

function projectionColumns(driverDial: DialDef | undefined, driverKey: string, series: ProjectionSeriesDef[], points: ProjectionPoint[]) {
  const driverFormat = driverDial?.format ?? 'integer';
  const driverOptions = driverDial?.options;
  const driverHeader = driverDial?.label ?? driverKey;
  const driverWidth = Math.max(
    driverHeader.length,
    PROJECTION_COL_FLOOR,
    ...points.map((p) => fmtDialValue(p.x, driverFormat, driverOptions).length),
  );
  const seriesWidths = series.map((s, i) => Math.max(
    s.label.length,
    PROJECTION_COL_FLOOR,
    ...points.map((p) => fmtValue(p.values[i], s.format, s.signed).length),
  ));
  return { driverFormat, driverOptions, driverHeader, driverWidth, seriesWidths };
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

// A row's start year steps through [undefined, MIN_ROW_YEAR, ..., MAX_ROW_YEAR].
// undefined means "no start bound" (active from the past). Stepping left off
// MIN_ROW_YEAR lands on undefined; stepping right from undefined lands on
// MIN_ROW_YEAR and climbs from there, clamped at MAX_ROW_YEAR.
function stepStartYear(dir: 1 | -1, val: number | undefined): number | undefined {
  if (val === undefined) return dir === 1 ? MIN_ROW_YEAR : undefined;
  const next = val + dir;
  if (next < MIN_ROW_YEAR) return undefined;
  if (next > MAX_ROW_YEAR) return MAX_ROW_YEAR;
  return next;
}

// A row's end year steps through [MIN_ROW_YEAR, ..., MAX_ROW_YEAR, undefined].
// undefined means "no end bound" (active into the future/ongoing). Stepping
// right off MAX_ROW_YEAR lands on undefined; stepping left from undefined
// lands on MAX_ROW_YEAR and descends from there, clamped at MIN_ROW_YEAR.
function stepEndYear(dir: 1 | -1, val: number | undefined): number | undefined {
  if (val === undefined) return dir === 1 ? undefined : MAX_ROW_YEAR;
  const next = val + dir;
  if (next > MAX_ROW_YEAR) return undefined;
  if (next < MIN_ROW_YEAR) return MIN_ROW_YEAR;
  return next;
}

// Parses a typed edit-buffer for a start/end year cell, same clamp-on-commit
// convention as every other numeric dial/list cell in this file. A blank
// buffer commits to `undefined` (no bound) — the same "unbounded" state ←→
// stepping can reach — rather than being rejected as invalid input. `null`
// means the buffer didn't parse and the existing value should be left alone
// (mirrors the isNaN guard used for amount/dial edits).
function parseYearCellInput(buffer: string): number | undefined | null {
  const trimmed = buffer.trim();
  if (!trimmed) return undefined;
  const n = parseInt(trimmed, 10);
  if (isNaN(n)) return null;
  if (n < MIN_ROW_YEAR) return MIN_ROW_YEAR;
  if (n > MAX_ROW_YEAR) return MAX_ROW_YEAR;
  return n;
}

// ─── CanvasView — testable rendering of a CanvasSpec ─────────────────────────

export function CanvasView({ spec, isActive, onEditingChange }: {
  spec: LoadedCanvasSpec;
  isActive?: boolean;
  // Fired whenever this view's internal edit-mode flag changes, so a parent
  // (Canvas() below) that has its own sibling useInput can suppress its own
  // digit-nav / Escape-to-dashboard handling while this view is mid-edit.
  // Ink has no stopPropagation between independent useInput hooks — both fire
  // on every keypress — so this is the only way for the parent to know.
  onEditingChange?: (editing: boolean) => void;
}) {
  // Unconditional — every dial in the spec, visible or not — so a hidden sub-dial's
  // value is seeded once at load and survives being hidden and reshown later
  // (freeze semantics, not reset-on-hide).
  const allDials = spec.elements.flatMap((el) => el.type === 'dial' ? [el.dial] : []);
  const [dialValues, setDialValues] = useState<Record<string, number>>(() => {
    const d: Record<string, number> = {};
    allDials.forEach((dl) => { d[dl.key] = dl.default; });
    return d;
  });

  // Local, mutable copy of every list's rows, seeded once from the spec at mount.
  // Like dialValues, but UNLIKE dialValues these edits are meant to survive: every
  // committed add/remove/cell-edit is persisted via updateHistoryEntrySpec +
  // resolveAndWriteCanvasSpec (see persistListRows below). Kept as local state
  // rather than reading `spec.elements` directly so an edit is reflected
  // immediately, without waiting on a disk round-trip back through the
  // CANVAS_SPEC_PATH watcher in App.tsx — which would also remount this whole
  // view, since Canvas.tsx keys CanvasView by specKey.
  const [listRows, setListRows] = useState<Record<string, ListRowDef[]>>(() => {
    const r: Record<string, ListRowDef[]> = {};
    spec.elements.forEach((el) => { if (el.type === 'list') r[el.list.key] = el.list.rows; });
    return r;
  });
  const rowIdCounterRef = useRef(0);

  // `spec.elements` with each list's rows swapped for the current local copy —
  // visibility, sum_active()/count() scope, output exprs and rendering all read
  // this instead of `spec.elements` directly, so row edits are reflected exactly
  // like dial edits already are.
  const effectiveElements = spec.elements.map((el) =>
    el.type === 'list' ? { ...el, list: { ...el.list, rows: listRows[el.list.key] ?? el.list.rows } } : el
  );
  const lists = buildListScope(effectiveElements);

  // Visibility-filtered — recomputed every render since `visible` expressions read
  // live dial values (and now list data). Original spec index is kept as the React
  // key so elements above a toggled one don't get remounted when the list
  // shrinks/grows.
  const visibleElements = effectiveElements
    .map((el, originalIndex) => ({ el, originalIndex }))
    .filter(({ el }) => el.visible === undefined || evalExpr(el.visible, dialValues, lists) !== 0);
  const visibleDials = visibleElements.flatMap(({ el }) => el.type === 'dial' ? [el.dial] : []);

  // Every output's computed value, keyed by its original element index — so a later
  // output's `expr` can reference an earlier output's `key`, the same way it already
  // references a dial key. Computed over the *full, unfiltered* `effectiveElements`
  // (not `visibleElements`): hidden outputs must still compute so a later visible
  // output can reference them — visibility only gates rendering, not computation
  // (computeOutputValues() ignores `visible` entirely; see core/canvas-spec.ts).
  const outputValuesInOrder = computeOutputValues(effectiveElements, dialValues, lists);
  const outputValueByIndex = new Map<number, number>();
  {
    let i = 0;
    effectiveElements.forEach((el, idx) => {
      if (el.type === 'output') outputValueByIndex.set(idx, outputValuesInOrder[i++]);
    });
  }

  // Shared value-column width for this render: the widest formatted value across
  // every visible dial and output, floored at VALUE_W. Computed once here (rather
  // than per-row inside DialRow) so every row's `[ ... ]` box is exactly as wide as
  // the single widest value actually present — a $1,093,389.00 balance no longer
  // widens only its own row and knocks that row's closing bracket out of the column
  // every other row's bracket sits in. Short-valued canvases still get VALUE_W, the
  // original floor, so they don't get artificially wide boxes.
  const valueWidth = visibleElements.reduce((max, { el, originalIndex }) => {
    if (el.type === 'dial') {
      const val = dialValues[el.dial.key] ?? el.dial.default;
      return Math.max(max, fmtDialValue(val, el.dial.format, el.dial.options).length);
    }
    if (el.type === 'output') {
      const val = outputValueByIndex.get(originalIndex) ?? NaN;
      return Math.max(max, fmtValue(val, el.output.format, el.output.signed).length);
    }
    return max;
  }, VALUE_W);

  // Flattened top-level cursor stops — every dial plus every list row's 3 editable
  // cells, in spec order (an empty list contributes one 'listAdd' placeholder stop
  // instead of zero, so there's always somewhere to land to add its first row —
  // mirrors Settings.tsx's "[a] Add child" action row). Keyed by stable string id,
  // never index — list length changes on every add/remove, the same reason dial
  // selection is already tracked by `key` rather than a raw index.
  const cursorStops: CursorStop[] = visibleElements.flatMap(({ el }) => {
    if (el.type === 'dial') return [{ kind: 'dial', key: el.dial.key } as CursorStop];
    if (el.type === 'list') {
      if (el.list.rows.length === 0) {
        return [{ kind: 'listAdd', listKey: el.list.key, key: `${el.list.key}:__add` } as CursorStop];
      }
      return el.list.rows.flatMap((row) =>
        LIST_CELLS.map((cell) => ({
          kind: 'listCell' as const, listKey: el.list.key, rowId: row.id, cell,
          key: `${el.list.key}:${row.id}:${cell}`,
        }))
      );
    }
    return [];
  });

  // Selection tracked by stable key, not index — see cursorStops above. Render
  // index is derived via findIndex(); if the previously-selected stop just
  // disappeared (hidden dial, or its list row was just removed), fall back to the
  // first stop rather than crashing or pointing past the end.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(() => cursorStops[0]?.key);
  const rawIdx = cursorStops.findIndex((s) => s.key === selectedKey);
  const stopIdx = rawIdx >= 0 ? rawIdx : 0;
  const currentStop = cursorStops[stopIdx];
  const currentDial = currentStop?.kind === 'dial' ? visibleDials.find((d) => d.key === currentStop.key) : undefined;
  const currentKey = currentStop?.kind === 'dial' ? currentStop.key : undefined;

  const [editMode, setEditMode] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');

  // Let the parent Canvas() know when we enter/leave edit mode. Its own
  // useInput has no way to see our local `editMode` state otherwise, and
  // without this it double-fires on every keystroke we're using to fill
  // editBuffer (digits get typed AND navigate to that digit's screen).
  useEffect(() => {
    onEditingChange?.(editMode);
  }, [editMode, onEditingChange]);

  function moveSelection(dir: 1 | -1) {
    if (cursorStops.length === 0) { setSelectedKey(undefined); return; }
    if (rawIdx === -1) { setSelectedKey(cursorStops[0].key); return; }
    const nextIdx = (rawIdx + dir + cursorStops.length) % cursorStops.length;
    setSelectedKey(cursorStops[nextIdx].key);
  }

  // Writes one list's rows back to local state immediately, then — only when this
  // spec came from a history entry (`_historyId` set) — persists the whole updated
  // spec via updateHistoryEntrySpec + resolveAndWriteCanvasSpec, the same pattern
  // show_canvas/load_canvas already use. Called only on a committed mutation (add,
  // remove, or Enter to commit a cell edit) — never per keystroke. Dial values are
  // never part of this: they stay exactly as ephemeral as before.
  function persistListRows(listKey: string, nextRows: ListRowDef[]) {
    setListRows((prev) => ({ ...prev, [listKey]: nextRows }));
    const historyId = spec._historyId;
    if (!historyId) return;
    const updatedElements = spec.elements.map((el) => {
      if (el.type !== 'list') return el;
      const rows = el.list.key === listKey ? nextRows : (listRows[el.list.key] ?? el.list.rows);
      return { ...el, list: { ...el.list, rows } };
    });
    const updatedSpec: CanvasSpec = { title: spec.title, elements: updatedElements };
    const updated = updateHistoryEntrySpec(historyId, updatedSpec);
    if (updated) void resolveAndWriteCanvasSpec(updated.spec, updated.id);
  }

  // Fresh id per new row — NOT the `${key}_${index}` scheme used at generation
  // time, which isn't idempotent under removal (two different rows could end up
  // with the same id after a remove+add). A counter seeded at 0 and combined with
  // Date.now() is unique even across several adds within the same millisecond.
  function newRowId(listKey: string): string {
    rowIdCounterRef.current += 1;
    return `${listKey}_row_${Date.now()}_${rowIdCounterRef.current}`;
  }

  function addRow(listKey: string) {
    const rows = listRows[listKey] ?? [];
    const id = newRowId(listKey);
    const nextRows = [...rows, { id, label: 'New row', amount: 0 }];
    persistListRows(listKey, nextRows);
    setSelectedKey(`${listKey}:${id}:label`);
  }

  function removeRow(listKey: string, rowId: string) {
    const rows = listRows[listKey] ?? [];
    persistListRows(listKey, rows.filter((r) => r.id !== rowId));
    // No explicit selection fix-up needed: once this row is gone, cursorStops on
    // the next render won't contain `selectedKey` any more, and stopIdx's
    // fall-back-to-0 above takes over automatically — same convention as a hidden
    // dial's selection falling back today.
  }

  function applyEdit(buffer: string) {
    if (currentStop?.kind === 'dial' && currentDial) {
      const n = parseFloat(buffer);
      if (!isNaN(n)) {
        let val = n;
        if (currentDial.min !== undefined && val < currentDial.min) val = currentDial.min;
        if (currentDial.max !== undefined && val > currentDial.max) val = currentDial.max;
        const k = currentStop.key;
        setDialValues((v) => ({ ...v, [k]: parseFloat(val.toFixed(10)) }));
      }
    } else if (currentStop?.kind === 'listCell') {
      const { listKey, rowId, cell } = currentStop;
      const rows = listRows[listKey] ?? [];
      const idx = rows.findIndex((r) => r.id === rowId);
      if (idx !== -1) {
        const row = rows[idx];
        let nextRow: ListRowDef = row;
        if (cell === 'label') {
          nextRow = { ...row, label: buffer.trim() };
        } else if (cell === 'amount') {
          const n = parseFloat(buffer);
          if (!isNaN(n)) nextRow = { ...row, amount: parseFloat(n.toFixed(10)) };
        } else if (cell === 'start') {
          const parsed = parseYearCellInput(buffer);
          if (parsed !== null) nextRow = { ...row, startYear: parsed };
        } else {
          const parsed = parseYearCellInput(buffer);
          if (parsed !== null) nextRow = { ...row, endYear: parsed };
        }
        persistListRows(listKey, [...rows.slice(0, idx), nextRow, ...rows.slice(idx + 1)]);
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
      // The label cell is free text; amount, start/end year (and dial values)
      // are restricted to the numeric-ish charset, matching dial editing today.
      const freeText = currentStop?.kind === 'listCell' && currentStop.cell === 'label';
      if (_input && !key.ctrl && !key.meta && (freeText || /^[\d.\-]$/.test(_input))) {
        setEditBuffer((b) => b + _input);
      }
      return;
    }
    if (key.upArrow)   { moveSelection(-1); return; }
    if (key.downArrow) { moveSelection(1); return; }

    if (key.return && currentStop) {
      if (currentStop.kind === 'dial' && currentDial && currentDial.format !== 'toggle' && currentDial.format !== 'select') {
        setEditBuffer(String(dialValues[currentStop.key] ?? currentDial.default));
        setEditMode(true);
        return;
      }
      if (currentStop.kind === 'listCell') {
        const rows = listRows[currentStop.listKey] ?? [];
        const row = rows.find((r) => r.id === currentStop.rowId);
        if (row) {
          const initial = currentStop.cell === 'label' ? row.label
            : currentStop.cell === 'amount' ? String(row.amount)
            : currentStop.cell === 'start' ? (row.startYear !== undefined ? String(row.startYear) : '')
            : (row.endYear !== undefined ? String(row.endYear) : '');
          setEditBuffer(initial);
          setEditMode(true);
        }
        return;
      }
      if (currentStop.kind === 'listAdd') {
        addRow(currentStop.listKey);
        return;
      }
    }

    if (key.rightArrow && currentStop?.kind === 'dial' && currentDial) {
      const k = currentStop.key;
      setDialValues((v) => ({ ...v, [k]: stepDialValue(currentDial, 1,  v[k] ?? currentDial.default) }));
    }
    if (key.leftArrow && currentStop?.kind === 'dial' && currentDial) {
      const k = currentStop.key;
      setDialValues((v) => ({ ...v, [k]: stepDialValue(currentDial, -1, v[k] ?? currentDial.default) }));
    }
    if ((key.rightArrow || key.leftArrow) && currentStop?.kind === 'listCell' &&
        (currentStop.cell === 'start' || currentStop.cell === 'end')) {
      const { listKey, rowId, cell } = currentStop;
      const dir: 1 | -1 = key.rightArrow ? 1 : -1;
      const rows = listRows[listKey] ?? [];
      const idx = rows.findIndex((r) => r.id === rowId);
      if (idx !== -1) {
        const row = rows[idx];
        const nextRow: ListRowDef = cell === 'start'
          ? { ...row, startYear: stepStartYear(dir, row.startYear) }
          : { ...row, endYear: stepEndYear(dir, row.endYear) };
        persistListRows(listKey, [...rows.slice(0, idx), nextRow, ...rows.slice(idx + 1)]);
      }
    }
    if (_input === 'r' && currentStop?.kind === 'dial' && currentDial) {
      const k = currentStop.key;
      setDialValues((v) => ({ ...v, [k]: currentDial.default }));
    }
    if (_input === 'a' && (currentStop?.kind === 'listCell' || currentStop?.kind === 'listAdd')) {
      addRow(currentStop.listKey);
      return;
    }
    if (_input === 'd' && currentStop?.kind === 'listCell') {
      removeRow(currentStop.listKey, currentStop.rowId);
      return;
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
          const val = outputValueByIndex.get(originalIndex) ?? NaN;
          return (
            <SelectableRow key={originalIndex} selected={false} gap={2}>
              {/* Same truncate-not-wrap treatment as DialRow's label column — an
                  oversized output label must not wrap and misalign the value column. */}
              <TruncatedText width={LABEL_W} dimColor>{out.label}</TruncatedText>
              <Text bold color={outputColor(out.color)}>{fmtValue(val, out.format, out.signed).padStart(valueWidth)}</Text>
            </SelectableRow>
          );
        }
        if (el.type === 'list') {
          const list = el.list;
          const format = list.amountFormat ?? 'dollar';
          const rows = list.rows;
          // Shared per-column widths across every row of THIS list — same
          // discipline as the canvas-wide `valueWidth` above, applied per list
          // rather than globally (a list's amounts/years aren't dial/output values
          // and don't share their column).
          const labelColWidth = rows.reduce((m, r) => Math.max(m, r.label.length), LIST_LABEL_W);
          const amountColWidth = rows.reduce((m, r) => Math.max(m, fmtDialValue(r.amount, format).length), VALUE_W);
          const startColWidth = rows.reduce((m, r) => Math.max(m, (r.startYear !== undefined ? String(r.startYear) : 'any').length), LIST_START_W);
          const endColWidth = rows.reduce((m, r) => Math.max(m, (r.endYear !== undefined ? String(r.endYear) : 'ongoing').length), LIST_END_W);

          const isCurrentCell = (rowId: string, cell: ListCell) =>
            currentStop?.kind === 'listCell' && currentStop.listKey === list.key &&
            currentStop.rowId === rowId && currentStop.cell === cell;
          const isAddSelected = currentStop?.kind === 'listAdd' && currentStop.listKey === list.key;

          return (
            <Box key={originalIndex} flexDirection="column" marginTop={1}>
              <Text bold dimColor>{list.label}</Text>
              {rows.length === 0 ? (
                <SelectableRow selected={isAddSelected} gap={2}>
                  <Text dimColor>No rows yet.</Text>
                  <Text color={isAddSelected ? C_ACCENT : undefined} dimColor={!isAddSelected}>[a] / Enter to add one</Text>
                </SelectableRow>
              ) : rows.map((row) => {
                const editingLabel  = isCurrentCell(row.id, 'label')  && editMode;
                const editingAmount = isCurrentCell(row.id, 'amount') && editMode;
                const editingStart  = isCurrentCell(row.id, 'start')  && editMode;
                const editingEnd    = isCurrentCell(row.id, 'end')    && editMode;
                const labelDisplay  = editingLabel  ? editBuffer : row.label;
                const amountDisplay = editingAmount ? editBuffer : fmtDialValue(row.amount, format);
                const startDisplay  = editingStart  ? editBuffer : (row.startYear !== undefined ? String(row.startYear) : 'any');
                const endDisplay    = editingEnd    ? editBuffer : (row.endYear   !== undefined ? String(row.endYear)   : 'ongoing');
                const rowSelected = isCurrentCell(row.id, 'label') || isCurrentCell(row.id, 'amount') ||
                  isCurrentCell(row.id, 'start') || isCurrentCell(row.id, 'end');
                const amountBoxWidth = Math.max(amountColWidth, amountDisplay.length) + 4 + (editingAmount ? 1 : 0);
                const startBoxWidth  = Math.max(startColWidth,  startDisplay.length)  + 4 + (editingStart  ? 1 : 0);
                const endBoxWidth    = Math.max(endColWidth,    endDisplay.length)    + 4 + (editingEnd    ? 1 : 0);
                return (
                  <SelectableRow key={row.id} selected={rowSelected} gap={2}>
                    <TruncatedText width={labelColWidth} color={isCurrentCell(row.id, 'label') ? C_ACCENT : undefined}>
                      {labelDisplay}
                      {editingLabel && <Text color={C_ACCENT}>{CURSOR}</Text>}
                    </TruncatedText>
                    <TruncatedText width={amountBoxWidth} color={isCurrentCell(row.id, 'amount') ? C_ACCENT : C_NEUTRAL} wrap="truncate-middle">
                      {'[ '}{amountDisplay.padStart(amountColWidth)}
                      {editingAmount && <Text color={C_ACCENT}>{CURSOR}</Text>}
                      {' ]'}
                    </TruncatedText>
                    <TruncatedText width={startBoxWidth} color={isCurrentCell(row.id, 'start') ? C_ACCENT : C_NEUTRAL} wrap="truncate-middle">
                      {'[ '}{startDisplay.padStart(startColWidth)}
                      {editingStart && <Text color={C_ACCENT}>{CURSOR}</Text>}
                      {' ]'}
                    </TruncatedText>
                    <TruncatedText width={endBoxWidth} color={isCurrentCell(row.id, 'end') ? C_ACCENT : C_NEUTRAL} wrap="truncate-middle">
                      {'[ '}{endDisplay.padStart(endColWidth)}
                      {editingEnd && <Text color={C_ACCENT}>{CURSOR}</Text>}
                      {' ]'}
                    </TruncatedText>
                  </SelectableRow>
                );
              })}
            </Box>
          );
        }
        if (el.type === 'table' || el.type === 'chart') {
          const proj: ProjectionDef = el.type === 'table' ? el.table : el.chart;
          const driverDial = effectiveElements.find(
            (e): e is Extract<CanvasElement, { type: 'dial' }> => e.type === 'dial' && e.dial.key === proj.driver,
          )?.dial;
          const points = projectSeries(effectiveElements, dialValues, lists, proj.driver, proj.series);

          if (points.length === 0) {
            return (
              <Box key={originalIndex} flexDirection="column" marginTop={1}>
                <Text bold dimColor>{proj.label}</Text>
                <Text dimColor>No data — check the driver dial's range.</Text>
              </Box>
            );
          }

          const { driverFormat, driverOptions, driverHeader, driverWidth, seriesWidths } =
            projectionColumns(driverDial, proj.driver, proj.series, points);

          // Chart-only: one shared bar-scale max across every series and every
          // point (not per-series) — same convention as Trends.tsx's flexMax,
          // which scales fixed/flexible/discretionary bars on one shared axis so
          // their magnitudes stay visually comparable across series.
          const barMax = el.type === 'chart'
            ? Math.max(...points.flatMap((p) => p.values.map((v) => Math.abs(v))), 1)
            : 0;
          const barWidth = proj.series.length > 1 ? Math.max(6, Math.floor(BAR_WIDTH / proj.series.length)) : BAR_WIDTH;

          return (
            <Box key={originalIndex} flexDirection="column" marginTop={1}>
              <Text bold dimColor>{proj.label}</Text>
              <ColumnHeader hasCursor marginTop={0} columns={[
                { label: driverHeader.toUpperCase(), width: driverWidth, align: 'right' },
                ...proj.series.map((s, i) => ({ label: s.label.toUpperCase(), width: seriesWidths[i], align: 'right' as const })),
              ]} />
              {points.map((p, idx) => (
                <SelectableRow key={idx} selected={false} gap={2}>
                  <Text dimColor>{fmtDialValue(p.x, driverFormat, driverOptions).padStart(driverWidth)}</Text>
                  {proj.series.map((s, i) => {
                    const v = p.values[i];
                    const color = seriesColor(s, v);
                    return (
                      <Box key={i} gap={2}>
                        <Text color={color}>{fmtValue(v, s.format, s.signed).padStart(seriesWidths[i])}</Text>
                        {el.type === 'chart' && <Text color={color}>{bar(v, barMax, barWidth)}</Text>}
                      </Box>
                    );
                  })}
                </SelectableRow>
              ))}
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
  onLoadSpec: (spec: LoadedCanvasSpec) => void;
  isActive?: boolean;
  showHints: boolean;
  spec: LoadedCanvasSpec | null;
  specKey: number;
}) {
  const [mode, setMode]           = useState<Mode>('view');
  const [search, setSearch]       = useState('');
  const [history, setHistory]     = useState<CanvasHistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const refreshKey = useRefreshKey();
  // Mirrors CanvasView's internal editMode (see onEditingChange above). While
  // true, the view-mode branch below must not act on the same keypress
  // CanvasView is consuming for its edit buffer — otherwise a digit typed into
  // a dial/list-cell edit also navigates to that digit's screen, and Escape to
  // cancel an edit also navigates to the dashboard.
  const [isEditingCanvas, setIsEditingCanvas] = useState(false);

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
        // Stored history entries don't carry `_historyId` on their spec (only
        // CANVAS_SPEC_PATH's on-disk envelope does) — attach the entry's own id
        // here so list-row edits made after loading from history can still be
        // persisted back to it.
        onLoadSpec({ ...filtered[historyIdx].spec, _historyId: filtered[historyIdx].id });
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
    // CanvasView is mid-edit (typing into a dial/list-cell edit buffer) — let
    // its own useInput exclusively handle this keypress. In particular, don't
    // let a digit here also switch screens, and don't let Escape here also
    // navigate to the dashboard on top of CanvasView cancelling the edit.
    if (isEditingCanvas) return;
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
              ? '↑↓ select  ·  ← → adjust  ·  Enter edit  ·  [a] add row  ·  [d] remove row  ·  [r] reset  ·  [/] history'
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
            ? <Box marginTop={1}><CanvasView key={specKey} spec={spec} isActive={isActive} onEditingChange={setIsEditingCanvas} /></Box>
            : <Box marginTop={1}><Text dimColor>Ask the agent (`) to generate a canvas — or press [/] to browse history.</Text></Box>
          }
        </>
      )}
    </Box>
  );
}
