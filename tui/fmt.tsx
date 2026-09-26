import React from 'react';
import { Text } from 'ink';
export { fmt, fmtSigned, fmtPct, fmtMonths, fmtCompact, fmtSpan, sortTags, type TagSort } from '../core/fmt.js';
export { BAR_WIDTH, bar, truncate, padTruncate } from './charUtils.js';

export function Divider({ width }: { width?: number }) {
  const w = width ?? Math.max(1, (process.stdout.columns ?? 80) - 4);
  return <Text dimColor>{'─'.repeat(w)}</Text>;
}
