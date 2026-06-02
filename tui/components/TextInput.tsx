import React from 'react';
import { Box, Text } from 'ink';
import { CURSOR, C_ACCENT } from '../ui.js';

/** Inline text input display: shows value (or dimmed placeholder) followed by the block cursor. */
export function TextInput({ value, color, placeholder }: { value: string; color?: string; placeholder?: string }) {
  return (
    <Box>
      {value ? (
        <Text color={color}>{value}</Text>
      ) : placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : null}
      <Text color={C_ACCENT}>{CURSOR}</Text>
    </Box>
  );
}
