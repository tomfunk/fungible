import React from 'react';
import { Text } from 'ink';

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return <Text bold dimColor>{children}</Text>;
}
