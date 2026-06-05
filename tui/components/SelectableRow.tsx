import React from 'react';
import { Box, Text } from 'ink';
import { C_ACCENT } from '../ui.js';

/**
 * Row with a ▶ / space cursor indicator. The indicator is flush-adjacent to the
 * first child (no gap between them), matching the existing cursor-embedded pattern.
 * gap applies between all children in the content area.
 */
export function SelectableRow({ selected, gap = 2, children }: { selected: boolean; gap?: number; children: React.ReactNode }) {
  return (
    <Box>
      <Text color={selected ? C_ACCENT : undefined}>{selected ? '▶ ' : '  '}</Text>
      <Box gap={gap}>{children}</Box>
    </Box>
  );
}
