import React from 'react';
import { Box, Text } from 'ink';
import { C_ACCENT, C_DIM, C_NEUTRAL } from '../ui.js';
import { TextInput } from './TextInput.js';

/** A text-input field row: `Label  [ value/cursor ]` */
export function EditTextField({
  label, labelWidth = 12, active, value, placeholder, color, emptyText = '—',
}: {
  label: string; labelWidth?: number; active: boolean;
  value: string; placeholder?: string; color?: string; emptyText?: string;
}) {
  return (
    <Box gap={2}>
      <Text color={active ? C_ACCENT : C_NEUTRAL}>{label.padEnd(labelWidth)}</Text>
      <Box>
        <Text color={active ? C_ACCENT : C_NEUTRAL}>{'[ '}</Text>
        {active
          ? <TextInput value={value} color={color} placeholder={placeholder} />
          : <Text color={value ? undefined : C_DIM}>{value || emptyText}</Text>}
        <Text color={active ? C_ACCENT : C_NEUTRAL}>{' ]'}</Text>
      </Box>
    </Box>
  );
}

/** A toggle/cycle field row: `Label  ← value →` */
export function EditToggleField({
  label, labelWidth = 12, active, value, valueColor,
}: {
  label: string; labelWidth?: number; active: boolean;
  value: string; valueColor?: string;
}) {
  return (
    <Box gap={2}>
      <Text color={active ? C_ACCENT : C_NEUTRAL}>{label.padEnd(labelWidth)}</Text>
      <Text color={active ? C_ACCENT : valueColor}>{'← '}{value}{'  →'}</Text>
    </Box>
  );
}
