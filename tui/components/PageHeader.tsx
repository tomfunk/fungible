import React from 'react';
import { Box, Text } from 'ink';
import type { Screen } from '../App.js';
import { NavHints } from '../nav.js';
import { C_ACCENT } from '../ui.js';

export function PageHeader({ current, showHints }: { current: Screen; showHints: boolean }) {
  return (
    <Box justifyContent="space-between">
      <Text bold color={C_ACCENT}>fungible</Text>
      <NavHints current={current} showHints={showHints} />
    </Box>
  );
}
