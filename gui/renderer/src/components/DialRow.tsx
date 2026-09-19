import { useState } from 'react';
import { fmtDialValue } from '../../../../core/canvas-spec.js';
import type { DialFormat } from '../../../../core/canvas-spec.js';
import styles from './DialRow.module.css';

// The dense stepper control shared by Health's assumption dials and Canvas's
// numeric dials — the GUI counterpart to tui/components/DialRow.tsx. Renders
// as label+value header / [−][number][+][reset] controls / hint, for every
// numeric dial shape. `toggle` and `select` are NOT numeric — those stay
// hand-rolled in Canvas.tsx with their own checkbox/select markup, so this
// component's format prop deliberately excludes them.
export type NumericDialFormat = Exclude<DialFormat, 'toggle' | 'select'>;

export function DialRow({
  label,
  value,
  defaultValue,
  step,
  min,
  max,
  format,
  hint,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  defaultValue: number;
  step: number;
  min?: number;
  max?: number;
  format: NumericDialFormat;
  hint: string;
  onChange: (v: number) => void;
  onReset?: () => void;
}) {
  const changed = value !== defaultValue;

  // A native <input type="number"> can't display commas at all — browsers
  // strip/reject non-digit characters, so value="12,700" just breaks. Showing
  // thousands-comma grouping for dollar dials means switching that input to
  // type="text" while formatted — but reformatting on every keystroke sends
  // the cursor to the wrong spot as commas shift mid-edit. Standard mitigation:
  // format only while NOT focused; while focused, fall back to the plain
  // type="number" raw-digit editing experience (arrow keys, apply()/clamp(),
  // browser-native min/max/step) exactly as before. Only 'dollar' gets this —
  // percent/integer/months/years/year keep a single always-type="number" input.
  const [focused, setFocused] = useState(false);
  const isDollar = format === 'dollar';
  const showFormatted = isDollar && !focused;

  function clamp(v: number): number {
    let n = v;
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    return n;
  }

  // Round to the nearest step so both manual typing and arrow-key/button
  // stepping stay aligned — generalizes Health's old spend-only roundToStep
  // to every dial, since every dial already carries a `step`.
  function apply(v: number) {
    onChange(clamp(Math.round(v / step) * step));
  }

  function handleReset() {
    if (onReset) onReset();
    else onChange(defaultValue);
  }

  // Inline unit adornment on the input itself, replacing the old header
  // readout — the input's raw number was always a duplicate of the header's
  // formatted one, so the format cue (currency, percent, duration) moves onto
  // the input instead of living in a second line. 'integer' and 'year' (a
  // plain calendar year, e.g. "2035") read fine as a bare number and get no
  // adornment. Suffix abbreviations ("mo"/"yr") match fmtValue/fmtDialValue's
  // existing convention in core/canvas-spec.ts and core/fmt.ts.
  const unitPrefix = format === 'dollar' ? '$' : undefined;
  const unitSuffix =
    format === 'percent' ? '%' : format === 'months' ? 'mo' : format === 'years' ? 'yr' : undefined;

  return (
    <div className={styles.dial}>
      <div className={styles.dialHeader}>
        <span className={styles.dialLabel}>{label}</span>
      </div>
      <div className={styles.dialControls}>
        <button className={styles.stepBtn} onClick={() => apply(value - step)}>
          −
        </button>
        <div className={`num ${styles.dialInputWrap}`}>
          {unitPrefix && <span className={styles.dialUnit}>{unitPrefix}</span>}
          <input
            type={showFormatted ? 'text' : 'number'}
            className={styles.dialInput}
            // fmtDialValue's own "$" is stripped since the unit prefix already
            // renders it just outside the input; its comma-grouping and
            // 0-vs-2-decimal convention stay, matching the reset tooltip below
            // and every other dollar readout in the app.
            value={showFormatted ? fmtDialValue(value, format).replace('$', '') : value}
            step={step}
            min={min}
            max={max}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (!isNaN(n)) apply(n);
            }}
            onKeyDown={(e) => {
              // Explicit arrow-key stepping: a range input gets this natively,
              // a bare number input doesn't reliably (and not at all in jsdom),
              // so wire it directly rather than lean on browser default behavior.
              // Still type="number" while focused (formatting only applies to
              // the blurred, non-editable display), so this keeps working as-is.
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                apply(value + step);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                apply(value - step);
              }
            }}
          />
          {unitSuffix && <span className={styles.dialUnit}>{unitSuffix}</span>}
        </div>
        <button className={styles.stepBtn} onClick={() => apply(value + step)}>
          +
        </button>
        {changed && (
          <button
            className={styles.resetBtn}
            onClick={handleReset}
            title={`Reset to ${fmtDialValue(defaultValue, format)}`}
          >
            reset
          </button>
        )}
      </div>
      <span className={`dim ${styles.dialHint}`}>
        {hint}
        {changed ? ' (modified)' : ''}
      </span>
    </div>
  );
}
