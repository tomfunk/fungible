import React from 'react';
import { Box, Text } from 'ink';

export function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{value}</Text>
    </Box>
  );
}
