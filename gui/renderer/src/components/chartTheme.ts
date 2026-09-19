import { useEffect, useState } from 'react';
import { useUiPrefs } from '../hooks/useUiPrefs.js';

export type ChartTheme = {
  grid: string;
  axis: string;
  positive: string;
  negative: string;
  accent: string;
  fixed: string;
  flexible: string;
  discretionary: string;
};

// Fallback values match the base (dark, default-palette) block in theme.css,
// used when the stylesheet isn't loaded (e.g. in tests, which don't import
// main.tsx / theme.css).
const FALLBACK: ChartTheme = {
  grid: '#2d3a4a',
  axis: '#8b98a8',
  positive: '#3fb950',
  negative: '#f8514f',
  accent: '#00d4aa',
  fixed: '#f8514f',
  flexible: '#d2a022',
  discretionary: '#38bdf8',
};

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readChartTheme(): ChartTheme {
  return {
    grid: cssVar('--border', FALLBACK.grid),
    axis: cssVar('--text-dim', FALLBACK.axis),
    positive: cssVar('--positive', FALLBACK.positive),
    negative: cssVar('--negative', FALLBACK.negative),
    accent: cssVar('--accent', FALLBACK.accent),
    fixed: cssVar('--flex-fixed', FALLBACK.fixed),
    flexible: cssVar('--flex-flexible', FALLBACK.flexible),
    discretionary: cssVar('--flex-discretionary', FALLBACK.discretionary),
  };
}

/**
 * Reads the live semantic chart colors from theme.css's CSS custom
 * properties (single source of truth — no hex values duplicated here beyond
 * the jsdom/no-stylesheet fallback), re-reading whenever the active
 * theme or color palette changes.
 */
export function useChartTheme(): ChartTheme {
  const { theme, palette } = useUiPrefs();
  const [chartTheme, setChartTheme] = useState<ChartTheme>(readChartTheme);

  useEffect(() => {
    // Deferred a frame: theme/palette are applied to the DOM by a sibling
    // effect in UiPrefsProvider, which (being higher in the tree) can run
    // after this one in the same commit — reading synchronously here would
    // sometimes catch the outgoing values. rAF guarantees that effect has
    // already flushed.
    const raf = requestAnimationFrame(() => setChartTheme(readChartTheme()));
    return () => cancelAnimationFrame(raf);
  }, [theme, palette]);

  return chartTheme;
}

export const tooltipStyle: React.CSSProperties = {
  background: 'var(--bg-raised)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 13,
};

export const tooltipLabelStyle: React.CSSProperties = {
  color: 'var(--text)',
  fontWeight: 600,
};
