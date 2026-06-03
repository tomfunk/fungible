import React from 'react';
import { Text } from 'ink';
import { SelectableRow } from './SelectableRow.js';
import { C_ACCENT, C_NEUTRAL } from '../ui.js';

export function DialRow({
  label,
  value,
  description,
  selected,
  labelWidth = 16,
  valueWidth = 12,
  valueColor,
}: {
  label: string;
  value: string;
  description: string;
  selected: boolean;
  labelWidth?: number;
  valueWidth?: number;
  valueColor?: string;
}) {
  return (
    <SelectableRow selected={selected} gap={2}>
      <Text color={selected ? C_ACCENT : undefined}>{label.padEnd(labelWidth)}</Text>
      <Text color={selected ? C_ACCENT : (valueColor ?? C_NEUTRAL)}>{'[ '}{value.padStart(valueWidth)}{' ]'}</Text>
      <Text dimColor>{description}</Text>
    </SelectableRow>
  );
}
