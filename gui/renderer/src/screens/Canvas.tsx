import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useQuery } from '../hooks/useQuery.js';
import { useNav } from '../hooks/useNav.js';
import { useScreenKeys } from '../hooks/useScreenKeys.js';
import { KeyHints } from '../components/KeyHints.js';
import { evalExpr, fmtValue, fmtDialValue } from '../../../../core/canvas-spec.js';
import type { CanvasSpec, DialDef } from '../../../../core/canvas-spec.js';
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
  const [showHistory, setShowHistory] = useState(false);
  const [search, setSearch] = useState('');
  const [historyKey, setHistoryKey] = useState(0);

  function loadSpec(s: CanvasSpec) {
    setSpec(s);
    setSpecKey((k) => k + 1);
    setShowHistory(false);
  }

  useEffect(() => {
    if (txFilter.canvasSpec) {
      try {
        loadSpec(JSON.parse(txFilter.canvasSpec));
        return;
      } catch {
        /* fall through to current spec */
      }
    }
    void api.canvas.loadCurrentSpec().then((s) => {
      if (s) loadSpec(s);
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
                  <tr key={e.id} className={styles.historyRow} onClick={() => loadSpec(e.spec)}>
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
          <CanvasView key={specKey} spec={spec} />
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

export function CanvasView({ spec }: { spec: CanvasSpec }) {
  const dials = spec.elements.flatMap((el) => (el.type === 'dial' ? [el.dial] : []));
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(dials.map((d) => [d.key, d.default])),
  );

  const setDial = (dial: DialDef, v: number) => setValues((prev) => ({ ...prev, [dial.key]: clampDial(dial, v) }));

  // Filter BEFORE rendering — a hidden element is excluded entirely (not just visually
  // hidden), so it doesn't occupy layout space or get picked up downstream. Dial values
  // themselves were already seeded from every dial above (visible or not), so a hidden
  // dial's value survives being hidden and reshown (freeze, not reset).
  const visibleElements = spec.elements
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => el.visible === undefined || evalExpr(el.visible, values) !== 0);

  return (
    <div className={styles.canvas}>
      <h2 className={styles.canvasTitle}>{spec.title}</h2>
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
          const hasRange = d.min !== undefined && d.max !== undefined;
          const compact = d.format === 'toggle' || d.format === 'select';
          return (
            <div key={i} className={compact ? `${styles.dial} ${styles.dialCompact}` : styles.dial}>
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
                ) : d.format === 'select' ? (
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
                ) : (
                  <>
                    <button className={styles.stepBtn} onClick={() => setDial(d, val - d.step)}>
                      −
                    </button>
                    {hasRange ? (
                      <input
                        type="range"
                        className={styles.slider}
                        min={d.min}
                        max={d.max}
                        step={d.step}
                        value={val}
                        onChange={(e) => setDial(d, parseFloat(e.target.value))}
                      />
                    ) : (
                      <input
                        type="number"
                        className={styles.numInput}
                        value={val}
                        step={d.step}
                        onChange={(e) => {
                          const n = parseFloat(e.target.value);
                          if (!isNaN(n)) setDial(d, n);
                        }}
                      />
                    )}
                    <button className={styles.stepBtn} onClick={() => setDial(d, val + d.step)}>
                      +
                    </button>
                  </>
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
        // output
        const out = el.output;
        const val = evalExpr(out.expr, values);
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
