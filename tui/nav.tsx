import React from 'react';
import { Box, Text } from 'ink';
import type { Screen } from './App.js';

const SCREEN_KEYS: Record<string, Screen> = {
  '1': 'dashboard',
  '2': 'transactions',
  '3': 'trends',
  '4': 'networth',
  '5': 'tags',
  '6': 'health',
  '7': 'rules',
  '8': 'accounts',
};

const LABELS: Record<Screen, string> = {
  dashboard: 'dash', transactions: 'txns', trends: 'trends',
  networth: 'worth', tags: 'tags', health: 'health', rules: 'rules', accounts: 'accounts',
};

// Split into two rows so each row stays short enough for narrow terminals
const ROW1: Screen[] = ['dashboard', 'transactions', 'trends', 'networth'];
const ROW2: Screen[] = ['tags', 'health', 'rules', 'accounts'];

const keyOf = (s: Screen) => Object.entries(SCREEN_KEYS).find(([, v]) => v === s)![0];
const hint  = (s: Screen) => `[${keyOf(s)}] ${LABELS[s]}`;

/** Two-line right-aligned nav hints, excluding the current screen. */
export function NavHints({ current, showHints }: { current: Screen; showHints: boolean }) {
  if (!showHints) return <Text dimColor>[h]</Text>;
  const row1 = ROW1.filter((s) => s !== current).map(hint).join('  ');
  const row2 = ROW2.filter((s) => s !== current).map(hint).join('  ');
  return (
    <Box flexDirection="column" alignItems="flex-end">
      <Text dimColor>{row1}</Text>
      <Text dimColor>{row2}</Text>
    </Box>
  );
}

/**
 * Handle numeric navigation keys (1–8). Skips the current screen's own key.
 * Returns true if the key was a nav key (so callers can early-return).
 */
export function handleNavKey(
  input: string,
  current: Screen,
  onNavigate: (s: Screen) => void,
): boolean {
  const screen = SCREEN_KEYS[input];
  if (!screen || screen === current) return false;
  onNavigate(screen);
  return true;
}
