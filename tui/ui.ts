import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export const CURSOR = '▊';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Display aliases for account subtypes that have ugly raw values. */
export const SUBTYPE_DISPLAY: Record<string, string> = {
  'crypto exchange': 'crypto',
};

/** Semantic palette — swap these to support colorblind mode. */
export const C_POSITIVE = 'green'   as const;  // income, positive values, assets, good health
export const C_NEGATIVE = 'red'     as const;  // expenses, negative values, liabilities, bad health
export const C_WARNING  = 'yellow'  as const;  // caution, approaching limits, moderate risk
export const C_NEUTRAL  = 'white'   as const;  // neutral / neither good nor bad
export const C_MANUAL   = 'magenta' as const;  // manual overrides, delta indicator
export const C_ACCENT   = 'cyan'    as const;  // primary accent: selection, focus, brand, interactive elements
export const C_DIM      = 'gray'    as const;  // inactive / unfocused elements (complement to C_ACCENT)

export const FLEX_COLORS: Record<'fixed' | 'flexible' | 'discretionary', string> = {
  fixed:         C_NEGATIVE,
  flexible:      C_WARNING,
  discretionary: C_ACCENT,
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
