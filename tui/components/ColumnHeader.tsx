import React from 'react';
import { Box, Text } from 'ink';

type Col = { label: string; width?: number; align?: 'left' | 'right' };

/**
 * A row of dimColor column headers. Set hasCursor to align with SelectableRow rows
 * (adds a 2-char placeholder matching the ▶ / space indicator).
 */
export function ColumnHeader({ columns, hasCursor = false, marginTop = 1 }: { columns: Col[]; hasCursor?: boolean; marginTop?: number }) {
  const cells = columns.map(({ label, width, align }, i) => (
    <Text key={i} dimColor>
      {width ? (align === 'right' ? label.padStart(width) : label.padEnd(width)) : label}
    </Text>
  ));
  if (hasCursor) {
    return (
      <Box marginTop={marginTop}>
        <Text>{'  '}</Text>
        <Box gap={2}>{cells}</Box>
      </Box>
    );
  }
  return <Box gap={2} marginTop={marginTop}>{cells}</Box>;
}
