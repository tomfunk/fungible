import React from 'react';
import { Box, Text } from 'ink';

/**
 * Fixed-width text cell that truncates with an ellipsis instead of wrapping.
 *
 * Ink's Yoga layout only truncates a `wrap="truncate-end"` Text correctly when
 * its containing Box has an explicit width — an unconstrained flex-shrinkable
 * Text with `wrap="truncate-end"` is measured differently than one with
 * `wrap="wrap"`, and the shrink pressure lands on the wrong sibling column
 * instead of truncating this one. Pinning the width also keeps this column's
 * rendered width constant regardless of the text's own length, which is what
 * keeps every row in a table one line tall and its later columns aligned —
 * whether the overlong text is a dial label or a hint/description.
 *
 * `children` may be a plain string or a small tree of nested `<Text>` nodes
 * (e.g. a bracketed value with a differently-colored cursor in the middle) —
 * Ink flattens nested Text into one line for wrapping purposes, so the whole
 * tree still truncates/wraps as a single unit rather than each nested Text
 * wrapping independently. `wrap` defaults to `truncate-end`; pass
 * `truncate-middle` for content whose edges (e.g. `[` and `]`) matter more
 * than its middle.
 */
export function TruncatedText({ width, color, dimColor, bold, wrap = 'truncate-end', children }: {
  width: number;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  wrap?: 'truncate-end' | 'truncate-middle';
  children: React.ReactNode;
}) {
  return (
    <Box width={width}>
      <Text color={color} dimColor={dimColor} bold={bold} wrap={wrap}>{children}</Text>
    </Box>
  );
}
