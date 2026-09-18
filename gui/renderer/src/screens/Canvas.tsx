import React, { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useNav } from '../hooks/useNav.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { DialRow } from '../components/DialRow.js';
import {
  computeOutputValues,
  evalExpr,
  fmtValue,
  fmtDialValue,
  buildListScope,
  projectSeries,
} from '../../../../core/canvas-spec.js';
import type { CanvasSpec, DialDef, ListDef, ListRowDef, ProjectionDef, ProjectionPoint } from '../../../../core/canvas-spec.js';
import { useChartTheme, tooltipStyle, tooltipLabelStyle, type ChartTheme } from '../components/chartTheme.js';
import styles from './Canvas.module.css';

function outputClass(color: string | undefined): string {
  switch (color) {
    case 'positive':
      return 'pos';
    case 'negative':
      return 'neg';
    case 'accent':
      return 'accent';
    default:
      return '';
  }
}

// Maps a projection series' semantic color to a chart line color, reusing the
// same theme tokens NetWorth/Trends draw from. 'neutral' (and unset) falls back
// to the axis color — matching how outputClass() above renders neutral as no
// special class (plain text color) rather than inventing a fifth chart hue.
function seriesColor(color: string | undefined, chartTheme: ChartTheme): string {
  switch (color) {
    case 'positive':
      return chartTheme.positive;
    case 'negative':
      return chartTheme.negative;
    case 'accent':
      return chartTheme.accent;
    default:
      return chartTheme.axis;
  }
}

function clampDial(dial: DialDef, v: number): number {
  let val = v;
  if (dial.min !== undefined && val < dial.min) val = dial.min;
  if (dial.max !== undefined && val > dial.max) val = dial.max;
  return parseFloat(val.toFixed(10));
}

export function Canvas() {
  const { txFilter } = useNav();
  const [spec, setSpec] = useState<CanvasSpec | null>(null);
  const [specKey, setSpecKey] = useState(0);
  const [historyId, setHistoryId] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [historyKey, setHistoryKey] = useState(0);

  function loadSpec(s: CanvasSpec, hid?: string) {
    setSpec(s);
    setSpecKey((k) => k + 1);
    setHistoryId(hid);
    setShowHistory(false);
  }

  useEffect(() => {
    if (txFilter.canvasSpec) {
      try {
        loadSpec(JSON.parse(txFilter.canvasSpec));
        // The agent's `show` tool carries the raw spec it just generated, with no
        // history id attached — show_canvas (called moments earlier in the same
        // turn) already persisted it and wrote CANVAS_SPEC_PATH tagged with
        // _historyId, so recover it from there rather than threading it through
        // the `show` tool's args.
        void api.canvas.loadCurrentSpec().then((s) => setHistoryId(s?._historyId));
        return;
      } catch {
        /* fall through to current spec */
      }
    }
    void api.canvas.loadCurrentSpec().then((s) => {
      if (s) loadSpec(s, s._historyId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useScreenKeys({
    '/': () => setShowHistory((v) => !v),
    Escape: () => setShowHistory(false),
  });

  const history = useQuery(() => api.canvas.loadHistory(), [historyKey]) ?? [];
  const filtered = search
    ? history.filter(
        (e) =>
          e.title.toLowerCase().includes(search.toLowerCase()) ||
          e.prompt.toLowerCase().includes(search.toLowerCase()),
      )
    : history;

  return (
    <div className={styles.screen}>
      <KeyHints hints="[1-9·0] screens   [/] history   [esc] close history" />
      <div className={styles.topBar}>
        <h1 className={styles.title}>Canvas</h1>
        <button className={styles.historyBtn} onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'close history' : `history (${history.length})`}
        </button>
      </div>

      {showHistory && (
        <section className={styles.panel}>
          <input
            className={styles.search}
            placeholder="Search canvases…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {filtered.length === 0 ? (
            <p className="dim">No canvases found.</p>
          ) : (
            <table className={styles.historyTable}>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id} className={styles.historyRow} onClick={() => loadSpec(e.spec, e.id)}>
                    <td className={styles.tdTitle}>{e.title}</td>
                    <td className="dim">{e.prompt}</td>
                    <td className="num dim">{(e.versions ?? 0) > 1 ? `v${e.versions}` : ''}</td>
                    <td className="num dim">{(e.updatedAt ?? e.createdAt).slice(0, 10)}</td>
                    <td>
                      <button
                        className={styles.deleteBtn}
                        onClick={async (ev) => {
                          ev.stopPropagation();
                          await api.canvas.deleteHistoryEntry(e.id);
                          setHistoryKey((k) => k + 1);
                        }}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {spec ? (
        <section className={styles.panel}>
          <CanvasView key={specKey} spec={spec} historyId={historyId} />
        </section>
      ) : (
        !showHistory && (
          <p className="dim">
            No canvas yet — ask the agent (press ` ) to build one, e.g. “when can I pay off my credit card?”
          </p>
        )
      )}
    </div>
  );
}

export function CanvasView({ spec, historyId }: { spec: CanvasSpec; historyId?: string }) {
  // Own list-row edits locally so add/remove/edit re-render and recompute
  // immediately — CanvasView remounts (via the parent's `key={specKey}`) whenever a
  // different canvas loads, so seeding this directly from the `spec` prop (rather
  // than a lazy initializer) matches how `values` below already does it.
  const [localSpec, setLocalSpec] = useState<CanvasSpec>(spec);
  const elements = localSpec.elements;
  const chartTheme = useChartTheme();

  const dials = elements.flatMap((el) => (el.type === 'dial' ? [el.dial] : []));
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(dials.map((d) => [d.key, d.default])),
  );

  const setDial = (dial: DialDef, v: number) => setValues((prev) => ({ ...prev, [dial.key]: clampDial(dial, v) }));

  // { [list.key]: rows } for sum_active()/count() — rebuilt every render off the
  // current localSpec so a row edit is reflected immediately, before any commit/
  // persist happens.
  const lists = buildListScope(elements);

  // Every keystroke in a list row updates localSpec (and therefore `lists` above)
  // so outputs recompute live. Persistence to disk only happens via commitListRows,
  // fired on a discrete commit (blur, add, remove) — never on every keystroke.
  function updateListRows(key: string, rows: ListRowDef[]) {
    setLocalSpec((prev) => ({
      ...prev,
      elements: prev.elements.map((el) =>
        el.type === 'list' && el.list.key === key ? { ...el, list: { ...el.list, rows } } : el,
      ),
    }));
  }

  function commitListRows(key: string, rows: ListRowDef[]) {
    setLocalSpec((prev) => {
      const next: CanvasSpec = {
        ...prev,
        elements: prev.elements.map((el) =>
          el.type === 'list' && el.list.key === key ? { ...el, list: { ...el.list, rows } } : el,
        ),
      };
      // No historyId (e.g. a canvas rendered ad hoc without a saved history entry
      // yet) means there's nowhere to persist to — the edit still applies locally.
      if (historyId) void api.canvas.updateSpec(historyId, next);
      return next;
    });
  }

  // computeOutputValues() returns one number per output element, in original array
  // order — evaluated over the FULL, unfiltered element list (not visibleElements
  // below) because a hidden output must still compute so a later visible output can
  // reference it by key. outputValueByIndex maps each element's original index (the
  // same `i` used for React keys) to its slot in that results array, so the render
  // loop below can look a value up by `i` instead of re-evaluating `expr` itself.
  const outputValues = computeOutputValues(elements, values, lists);
  const outputValueByIndex = new Map<number, number>();
  {
    let o = 0;
    elements.forEach((el, i) => {
      if (el.type === 'output') outputValueByIndex.set(i, outputValues[o++]);
    });
  }

  // Filter BEFORE rendering — a hidden element is excluded entirely (not just visually
  // hidden), so it doesn't occupy layout space or get picked up downstream. Dial values
  // themselves were already seeded from every dial above (visible or not), so a hidden
  // dial's value survives being hidden and reshown (freeze, not reset).
  const visibleElements = elements
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => el.visible === undefined || evalExpr(el.visible, values, lists) !== 0);

  return (
    <div className={styles.canvas}>
      <h2 className={styles.canvasTitle}>{localSpec.title}</h2>
      {visibleElements.map(({ el, i }) => {
        if (el.type === 'section') {
          return (
            <h3 key={i} className={styles.sectionLabel}>
              {el.label}
            </h3>
          );
        }
        if (el.type === 'text') {
          return (
            <p key={i} className={`dim ${styles.text}`}>
              {el.content}
            </p>
          );
        }
        if (el.type === 'dial') {
          const d = el.dial;
          const val = values[d.key] ?? d.default;
          const modified = val !== d.default;

          // toggle/select are not numeric dials — different controls (checkbox,
          // native <select>) that DialRow deliberately doesn't handle. Keep them
          // hand-rolled with Canvas's own compact wrapper.
          if (d.format === 'toggle' || d.format === 'select') {
            return (
              <div key={i} className={`${styles.dial} ${styles.dialCompact}`}>
                <div className={styles.dialTop}>
                  <span className={styles.dialLabel} title={d.hint}>
                    {d.label}
                  </span>
                  {d.format !== 'toggle' && (
                    <span className={`num ${styles.dialValue}`}>{fmtDialValue(val, d.format, d.options)}</span>
                  )}
                </div>
                <div className={styles.dialControls}>
                  {d.format === 'toggle' ? (
                    <label className={styles.toggle}>
                      <input
                        type="checkbox"
                        checked={val !== 0}
                        onChange={(e) => setDial(d, e.target.checked ? 1 : 0)}
                      />
                      <span className={styles.toggleTrack} />
                      <span className={styles.toggleThumb} />
                    </label>
                  ) : (
                    <select
                      className={styles.selectInput}
                      value={String(Math.round(val))}
                      onChange={(e) => setDial(d, parseFloat(e.target.value))}
                    >
                      {(d.options ?? []).map((opt, idx) => (
                        <option key={idx} value={idx}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )}
                  {modified && (
                    <button className={styles.resetBtn} onClick={() => setDial(d, d.default)}>
                      reset
                    </button>
                  )}
                </div>
                <span className={`dim ${styles.dialHint}`}>{d.hint}</span>
              </div>
            );
          }

          // Every other format (dollar/percent/integer/months/years) is a plain
          // numeric dial — the shared stepper, whether or not it has a min/max.
          return (
            <DialRow
              key={i}
              label={d.label}
              value={val}
              defaultValue={d.default}
              step={d.step}
              min={d.min}
              max={d.max}
              format={d.format}
              hint={d.hint}
              onChange={(v) => setDial(d, v)}
            />
          );
        }
        if (el.type === 'list') {
          return (
            <ListElement
              key={i}
              list={el.list}
              onChange={(rows) => updateListRows(el.list.key, rows)}
              onCommit={(rows) => commitListRows(el.list.key, rows)}
            />
          );
        }
        if (el.type === 'chart' || el.type === 'table') {
          const proj = el.type === 'chart' ? el.chart : el.table;
          const driverDial = dials.find((d) => d.key === proj.driver);
          const points = projectSeries(elements, values, lists, proj.driver, proj.series);
          const jumpToDriver = (x: number) => {
            if (driverDial) setDial(driverDial, x);
          };
          if (!driverDial || points.length === 0) {
            return (
              <div key={i} className={styles.projectionSection}>
                <h3 className={styles.sectionLabel}>{proj.label}</h3>
                <p className="dim">No data available — check the driver dial's range.</p>
              </div>
            );
          }
          return el.type === 'chart' ? (
            <ProjectionChart
              key={i}
              proj={proj}
              driverDial={driverDial}
              points={points}
              chartTheme={chartTheme}
              onJump={jumpToDriver}
            />
          ) : (
            <ProjectionTable key={i} proj={proj} driverDial={driverDial} points={points} onJump={jumpToDriver} />
          );
        }
        // output
        const out = el.output;
        const val = outputValueByIndex.get(i) ?? NaN;
        return (
          <div key={i} className={styles.output}>
            <span className={styles.outputLabel}>{out.label}</span>
            <span className={`num ${outputClass(out.color)} ${styles.outputValue}`}>
              {fmtValue(val, out.format, out.signed)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// A `chart` element — one line per series, plotted across the driver dial's full
// range (one point per projectSeries() step). Clicking a point jumps the driver
// dial to that x-value, same pattern as Trends.tsx's onChartClick, so the rest of
// the canvas (outputs, other charts sharing the same driver) recomputes live.
function ProjectionChart({
  proj,
  driverDial,
  points,
  chartTheme,
  onJump,
}: {
  proj: ProjectionDef;
  driverDial: DialDef;
  points: ProjectionPoint[];
  chartTheme: ChartTheme;
  onJump: (x: number) => void;
}) {
  const data = points.map((p) => {
    const row: Record<string, number> = { x: p.x };
    proj.series.forEach((s, idx) => {
      row[`s${idx}`] = p.values[idx];
    });
    return row;
  });

  function onChartClick(state: { activeLabel?: unknown } | null) {
    if (!state || state.activeLabel === undefined) return;
    const point = points.find((p) => p.x === state.activeLabel);
    if (point) onJump(point.x);
  }

  return (
    <div className={styles.projectionSection}>
      <h3 className={styles.sectionLabel}>{proj.label}</h3>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} onClick={onChartClick} style={{ cursor: 'pointer' }}>
          <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="x"
            stroke={chartTheme.axis}
            tick={{ fontSize: 12 }}
            minTickGap={24}
            tickFormatter={(v: number) => fmtDialValue(v, driverDial.format, driverDial.options)}
          />
          <YAxis
            stroke={chartTheme.axis}
            tick={{ fontSize: 12 }}
            width={70}
            tickFormatter={(v: number) => fmtValue(v, proj.series[0]?.format ?? 'dollar')}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            labelFormatter={(v) => fmtDialValue(Number(v), driverDial.format, driverDial.options)}
            formatter={(value, _name, item) => {
              const idx = Number(String(item?.dataKey ?? '0').slice(1));
              const s = proj.series[idx];
              return [s ? fmtValue(Number(value), s.format, s.signed) : String(value), s?.label ?? ''];
            }}
          />
          {proj.series.length > 1 && <Legend />}
          {proj.series.map((s, idx) => (
            <Line
              key={idx}
              type="monotone"
              dataKey={`s${idx}`}
              name={s.label}
              stroke={seriesColor(s.color, chartTheme)}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <p className={`dim ${styles.chartHint}`}>Click a point to move “{driverDial.label}” there</p>
    </div>
  );
}

// A `table` element — same driver/series data as ProjectionChart, rendered as a
// clickable-row table (driver value + one column per series). Row click jumps the
// driver dial to that row's x-value, matching the chart's click-to-jump.
function ProjectionTable({
  proj,
  driverDial,
  points,
  onJump,
}: {
  proj: ProjectionDef;
  driverDial: DialDef;
  points: ProjectionPoint[];
  onJump: (x: number) => void;
}) {
  return (
    <div className={styles.projectionSection}>
      <h3 className={styles.sectionLabel}>{proj.label}</h3>
      <table className={styles.projectionTable}>
        <thead>
          <tr>
            <th>{driverDial.label}</th>
            {proj.series.map((s, idx) => (
              <th key={idx} className="num">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, rowIdx) => (
            <tr key={rowIdx} className={styles.projectionRow} onClick={() => onJump(p.x)}>
              <td className="num">{fmtDialValue(p.x, driverDial.format, driverDial.options)}</td>
              {p.values.map((v, colIdx) => {
                const s = proj.series[colIdx];
                return (
                  <td key={colIdx} className={`num ${outputClass(s.color)}`}>
                    {fmtValue(v, s.format, s.signed)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Monotonic across every ListElement instance in the process — a new row's id only
// needs to be unique *within this session's editing*, never collide with the
// `${list.key}_${index}` scheme core assigns at generation time (which isn't
// idempotent under removal — see ListRowDef's docs in core/canvas-spec.ts), and
// survive several adds firing within the same millisecond (Date.now() alone can't).
let nextRowSeq = 0;

// One `list` element — a labeled, variable-length set of inline-editable rows
// (recurring expenses, income streams, one-time events). Fully controlled by the
// `list` prop: every keystroke calls `onChange` with the next full rows array so a
// parent-owned recompute (sum_active/count in another element) reflects it live;
// `onCommit` — fired on blur, add, or remove, never on every keystroke — is what
// the parent uses to persist to disk.
function ListElement({
  list,
  onChange,
  onCommit,
}: {
  list: ListDef;
  onChange: (rows: ListRowDef[]) => void;
  onCommit: (rows: ListRowDef[]) => void;
}) {
  function patchRow(id: string, patch: Partial<ListRowDef>) {
    onChange(list.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const row: ListRowDef = { id: `${list.key}_new_${nextRowSeq++}`, label: '', amount: 0 };
    const next = [...list.rows, row];
    onChange(next);
    onCommit(next);
  }

  function removeRow(id: string) {
    const next = list.rows.filter((r) => r.id !== id);
    onChange(next);
    onCommit(next);
  }

  // Blank means "no bound" (startYear/endYear are optional) — parseFloat('') is
  // NaN, so treat an empty field as `undefined` rather than coercing to a number.
  function parseYear(raw: string): number | undefined {
    if (raw.trim() === '') return undefined;
    const n = Math.round(parseFloat(raw));
    return isNaN(n) ? undefined : n;
  }

  return (
    <div className={styles.listSection}>
      <h3 className={styles.sectionLabel}>{list.label}</h3>
      {list.rows.map((row) => (
        <div key={row.id} className={styles.listRow}>
          <input
            className={styles.listLabelInput}
            value={row.label}
            placeholder="Label"
            onChange={(e) => patchRow(row.id, { label: e.target.value })}
            onBlur={() => onCommit(list.rows)}
          />
          <input
            type="number"
            className={styles.listAmountInput}
            value={row.amount}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              patchRow(row.id, { amount: isNaN(n) ? 0 : n });
            }}
            onBlur={() => onCommit(list.rows)}
          />
          <input
            type="number"
            className={styles.listYearInput}
            placeholder="start yr"
            value={row.startYear ?? ''}
            onChange={(e) => patchRow(row.id, { startYear: parseYear(e.target.value) })}
            onBlur={() => onCommit(list.rows)}
          />
          <span className={styles.listYearSep}>–</span>
          <input
            type="number"
            className={styles.listYearInput}
            placeholder="end yr"
            value={row.endYear ?? ''}
            onChange={(e) => patchRow(row.id, { endYear: parseYear(e.target.value) })}
            onBlur={() => onCommit(list.rows)}
          />
          <button
            className={styles.deleteBtn}
            onClick={() => removeRow(row.id)}
            aria-label={`Remove ${row.label || 'row'}`}
          >
            delete
          </button>
        </div>
      ))}
      <button className={styles.addRowBtn} onClick={addRow}>
        + add row
      </button>
    </div>
  );
}
