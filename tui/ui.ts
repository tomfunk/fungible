import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export const CURSOR = '▊';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Display aliases for account subtypes that have ugly raw values. */
export const SUBTYPE_DISPLAY: Record<string, string> = {
  'crypto exchange': 'crypto',
};

export const FLEX_COLORS: Record<'fixed' | 'flexible' | 'discretionary', string> = {
  fixed:         'red',
  flexible:      'yellow',
  discretionary: 'cyan',
};

export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => stdout.columns ?? 80);
  useEffect(() => {
    const update = () => setWidth(stdout.columns ?? 80);
    stdout.on('resize', update);
    return () => { stdout.off('resize', update); };
  }, [stdout]);
  return width;
}
