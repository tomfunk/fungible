import React from 'react';
import { Box, Text } from 'ink';
import { C_ACCENT } from '../ui.js';

export function ModalPanel({ title, borderColor, children }: { title?: string; borderColor?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={borderColor ?? C_ACCENT} paddingX={2} paddingY={1}>
      {title && <Text bold>{title}</Text>}
      {children}
    </Box>
  );
}
