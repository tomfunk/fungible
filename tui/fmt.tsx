import React from 'react';
import { Text } from 'ink';
export { BAR_WIDTH, fmt, fmtSigned, fmtPct, fmtMonths, bar, truncate } from '../core/fmt.js';

export function Divider({ width }: { width?: number }) {
  const w = width ?? Math.max(1, (process.stdout.columns ?? 80) - 4);
  return <Text dimColor>{'─'.repeat(w)}</Text>;
}
