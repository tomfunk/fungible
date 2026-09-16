import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export const CURSOR = '▊';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Display aliases for account subtypes that have ugly raw values. */
export const SUBTYPE_DISPLAY: Record<string, string> = {
  'crypto exchange': 'crypto',
};

/** Settings key for the active TUI color theme (see ThemeName). */
export const THEME_KEY = 'theme';

type FlexColors = Record<'fixed' | 'flexible' | 'discretionary', string>;

type Palette = {
  positive: string; // income, positive values, assets, good health
  negative: string; // expenses, negative values, liabilities, bad health
  warning: string;  // caution, approaching limits, moderate risk
  neutral: string;  // neutral / neither good nor bad
  manual: string;   // manual overrides, delta indicator
  accent: string;   // primary accent: selection, focus, brand, interactive elements
  dim: string;      // inactive / unfocused elements (complement to accent)
  flex: FlexColors;
};

// Okabe-Ito colorblind-safe blue/orange, used in place of red/green.
const CB_BLUE = '#0072B2';
const CB_ORANGE = '#E69F00';
const colorBlindPalette: Palette = {
  positive: CB_BLUE,
  negative: CB_ORANGE,
  warning:  'yellow',
  neutral:  'white',
  manual:   'magenta',
  accent:   'cyan',
  dim:      'gray',
  flex: { fixed: CB_ORANGE, flexible: 'yellow', discretionary: 'cyan' },
};

/** Named color themes. `deuteranopia` and `protanopia` intentionally share a palette — both remap the red/green axis to blue/orange, the distinction between them isn't color-relevant. */
export const THEMES = {
  default: {
    positive: 'green', negative: 'red', warning: 'yellow', neutral: 'white',
    manual: 'magenta', accent: 'cyan', dim: 'gray',
    flex: { fixed: 'red', flexible: 'yellow', discretionary: 'cyan' },
  },
  'high-contrast': {
    positive: 'greenBright', negative: 'redBright', warning: 'yellowBright', neutral: 'whiteBright',
    manual: 'magentaBright', accent: 'cyanBright',
    dim: 'gray', // left unchanged — "dim" is meant to recede regardless of contrast mode
    flex: { fixed: 'redBright', flexible: 'yellowBright', discretionary: 'cyanBright' },
  },
  deuteranopia: colorBlindPalette,
  protanopia: colorBlindPalette,
  monochrome: {
    // Call sites choose semantic constants (C_POSITIVE, C_NEGATIVE, ...), not raw
    // colors, so a true monochrome mode can't express meaning through hue without
    // rewriting all 357 call sites (out of scope here). This approximates it with
    // brightness tiers instead, which means some constants necessarily collide
    // (e.g. C_POSITIVE and C_ACCENT are both "brightest tier").
    positive: 'whiteBright', negative: 'white', warning: 'gray', neutral: 'white',
    manual: 'whiteBright', accent: 'whiteBright', dim: 'gray',
    flex: { fixed: 'white', flexible: 'gray', discretionary: 'whiteBright' },
  },
} as const satisfies Record<string, Palette>;

export type ThemeName = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/** Semantic palette — reassigned by applyTheme() to support colorblind/contrast modes. */
export let C_POSITIVE: string = THEMES.default.positive;
export let C_NEGATIVE: string = THEMES.default.negative;
export let C_WARNING:  string = THEMES.default.warning;
export let C_NEUTRAL:  string = THEMES.default.neutral;
export let C_MANUAL:   string = THEMES.default.manual;
export let C_ACCENT:   string = THEMES.default.accent;
export let C_DIM:      string = THEMES.default.dim;

export let FLEX_COLORS: FlexColors = { ...THEMES.default.flex };

/**
 * Applies a named theme by reassigning the C_* constants and FLEX_COLORS in
 * place. Call sites import these as ESM live bindings, so every existing
 * `color={C_POSITIVE}` reference picks up the new value automatically.
 * Falls back to `default` for an unrecognized name (e.g. a stale/invalid
 * setting). Must be called before the first render — switching themes at
 * runtime without restarting isn't supported.
 */
export function applyTheme(name: string): void {
  const theme = THEMES[name as ThemeName] ?? THEMES.default;
  C_POSITIVE = theme.positive;
  C_NEGATIVE = theme.negative;
  C_WARNING = theme.warning;
  C_NEUTRAL = theme.neutral;
  C_MANUAL = theme.manual;
  C_ACCENT = theme.accent;
  C_DIM = theme.dim;
  FLEX_COLORS = { ...theme.flex };
}

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
