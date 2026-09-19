import React from 'react';
import { Text } from 'ink';
import { SelectableRow } from './SelectableRow.js';
import { TruncatedText } from './TruncatedText.js';
import { C_ACCENT, C_NEUTRAL, CURSOR } from '../ui.js';

export function DialRow({
  label,
  value,
  description,
  selected,
  labelWidth = 16,
  valueWidth = 12,
  descriptionWidth = 44,
  valueColor,
  editing,
  editBuffer,
}: {
  label: string;
  value: string;
  description: string;
  selected: boolean;
  labelWidth?: number;
  valueWidth?: number;
  descriptionWidth?: number;
  valueColor?: string;
  editing?: boolean;
  editBuffer?: string;
}) {
  const displayValue = editing ? (editBuffer ?? '') : value;
  const resolvedValueColor = selected ? C_ACCENT : (valueColor ?? C_NEUTRAL);
  // Width sized to the actual content (never less than valueWidth, so a short
  // value still gets its usual column width; +4 for the '[ '/' ]' brackets,
  // +1 more while editing for the cursor glyph) so normal-width values never
  // truncate — only a genuinely squeezed terminal does. Without this bound the
  // bracket, value and cursor are three siblings that can each wrap onto their
  // own line independently under width pressure (a long label on another row,
  // or just a long formatted value, forcing the layout narrower) — that's the
  // "numbers end with '.'"/"values outside the box" bug: a closing bracket or
  // trailing digit dropped onto the next line. truncate-middle (rather than
  // -end) means a squeeze eats into the middle digits, not the brackets.
  const valueBoxWidth = Math.max(valueWidth, displayValue.length) + 4 + (editing ? 1 : 0);
  return (
    <SelectableRow selected={selected} gap={2}>
      {/* Fixed width + truncate-end so an oversized label (hand-authored spec,
          older history entry, or a future LLM slip past the ≤18-char guideline)
          renders as one line instead of wrapping and dragging every column after
          it onto a second/third line — see TruncatedText for the mechanism. */}
      <TruncatedText width={labelWidth} color={selected ? C_ACCENT : undefined}>{label}</TruncatedText>
      <TruncatedText width={valueBoxWidth} color={resolvedValueColor} wrap="truncate-middle">
        {'[ '}{displayValue.padStart(valueWidth)}
        {editing && <Text color={C_ACCENT}>{CURSOR}</Text>}
        {' ]'}
      </TruncatedText>
      {/* Fixed width so row height never depends on hint length or selection state
          (a long unselected hint and a short selected control hint must occupy the
          same single line) — truncate-end needs a bounded width to have any effect,
          and pinning it also keeps this column's width from fluctuating with the
          text's own natural size. */}
      <TruncatedText width={descriptionWidth} dimColor>{description}</TruncatedText>
    </SelectableRow>
  );
}
