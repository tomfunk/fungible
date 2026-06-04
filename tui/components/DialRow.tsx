import React from 'react';
import { Box, Text } from 'ink';
import { SelectableRow } from './SelectableRow.js';
import { C_ACCENT, C_NEUTRAL, CURSOR } from '../ui.js';

export function DialRow({
  label,
  value,
  description,
  selected,
  labelWidth = 16,
  valueWidth = 12,
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
  valueColor?: string;
  editing?: boolean;
  editBuffer?: string;
}) {
  const displayValue = editing ? (editBuffer ?? '') : value;
  return (
    <SelectableRow selected={selected} gap={2}>
      <Text color={selected ? C_ACCENT : undefined}>{label.padEnd(labelWidth)}</Text>
      <Box>
        <Text color={selected ? C_ACCENT : (valueColor ?? C_NEUTRAL)}>{'[ '}{displayValue.padStart(valueWidth)}</Text>
        {editing && <Text color={C_ACCENT}>{CURSOR}</Text>}
        <Text color={selected ? C_ACCENT : (valueColor ?? C_NEUTRAL)}>{' ]'}</Text>
      </Box>
      <Text dimColor>{description}</Text>
    </SelectableRow>
  );
}
