import React from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';
import { C_ACCENT, C_WARNING } from '../ui.js';

export function SearchBar({ value, hint = 'Esc cancel' }: { value: string; hint?: string }) {
  return (
    <Box gap={1} marginTop={1}>
      <Text color={C_ACCENT}>/</Text>
      <TextInput value={value} color={C_WARNING} />
      <Text dimColor>  {hint}</Text>
    </Box>
  );
}
