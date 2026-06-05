/**
 * Navigation consistency test
 *
 * Screens are numbered:
 *   1=dashboard  2=transactions  3=trends  4=networth  5=tags  6=health  7=rules  8=accounts  9=canvas
 *
 * Each screen must:
 *   1. Display a nav bar that shows [N] labels for every screen EXCEPT itself
 *   2. Handle every key 1–9 EXCEPT its own, navigating to the correct screen
 *
 * This test parses the TSX source files to verify both invariants.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TUI_DIR = join(__dirname, '..', 'tui');

const KEY_TO_SCREEN: Record<string, string> = {
  '1': 'dashboard',
  '2': 'transactions',
  '3': 'trends',
  '4': 'networth',
  '5': 'tags',
  '6': 'health',
  '7': 'rules',
  '8': 'accounts',
  '9': 'canvas',
};

const SCREENS = [
  { file: 'Dashboard.tsx',    screen: 'dashboard',    key: '1' },
  { file: 'Transactions.tsx', screen: 'transactions', key: '2' },
  { file: 'Trends.tsx',       screen: 'trends',       key: '3' },
  { file: 'NetWorth.tsx',     screen: 'networth',     key: '4' },
  { file: 'Tags.tsx',         screen: 'tags',         key: '5' },
  { file: 'Health.tsx',       screen: 'health',       key: '6' },
  { file: 'Rules.tsx',        screen: 'rules',        key: '7' },
  { file: 'Accounts.tsx',     screen: 'accounts',     key: '8' },
  { file: 'Canvas.tsx',       screen: 'canvas',       key: '9' },
];

/** Extract all [N] keys present in the nav bar of a source file.
 *  Handles two patterns:
 *  1. Inline: lines containing multiple [N] shortcut labels
 *  2. Component: <NavHints current="screenname" /> implies all other screens */
function extractNavBarKeys(src: string): string[] {
  // NavHints or PageHeader component: infer all keys except the current screen's
  const navHintsMatch = src.match(/<(?:NavHints|PageHeader)\s+current="([a-z]+)"/);
  if (navHintsMatch) {
    const current = navHintsMatch[1];
    return Object.entries(KEY_TO_SCREEN)
      .filter(([, dest]) => dest !== current)
      .map(([k]) => k);
  }

  // Inline fallback: find line with most [N] patterns
  const lines = src.split('\n');
  let bestLine = '';
  let bestCount = 0;
  for (const line of lines) {
    const matches = line.match(/\[([1-8])\]/g) ?? [];
    if (matches.length > bestCount) { bestCount = matches.length; bestLine = line; }
  }
  const keys = (bestLine.match(/\[([1-8])\]/g) ?? []).map((m) => m[1]);
  return [...new Set(keys)];
}

/** Extract input handler mappings: { key -> screen } from a source file.
 *  Handles two patterns:
 *  1. Inline: `if (input === 'N') { onNavigate('screen'); ... }`
 *  2. Helper: `handleNavKey(input, 'currentScreen', onNavigate)` — implies all
 *     other 7 screen keys are handled by the shared helper in nav.ts. */
function extractInputHandlers(src: string): Record<string, string> {
  const handlers: Record<string, string> = {};

  // Inline patterns
  const linePattern = /input === '([1-8])'[^)]*onNavigate\('([a-z]+)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = linePattern.exec(src)) !== null) handlers[m[1]] = m[2];

  const shortPattern = /if\s*\(input === '([1-8])'\)\s*\{?\s*onNavigate\('([a-z]+)'\)/g;
  while ((m = shortPattern.exec(src)) !== null) handlers[m[1]] = m[2];

  // handleNavKey(input, 'currentScreen', onNavigate) → all other 7 screens handled
  const navKeyPattern = /handleNavKey\(input,\s*'([a-z]+)',\s*\w+\)/g;
  while ((m = navKeyPattern.exec(src)) !== null) {
    const current = m[1];
    for (const [k, dest] of Object.entries(KEY_TO_SCREEN)) {
      if (dest !== current) handlers[k] = dest;
    }
  }

  return handlers;
}

describe('navigation consistency', () => {
  for (const { file, screen, key } of SCREENS) {
    describe(file, () => {
      const src = readFileSync(join(TUI_DIR, file), 'utf-8');
      const expectedKeys = Object.keys(KEY_TO_SCREEN).filter((k) => k !== key).sort();

      test('nav bar shows all other screens', () => {
        const navBarKeys = extractNavBarKeys(src).sort();
        expect(navBarKeys).toEqual(expectedKeys);
      });

      test('input handlers cover all other screens', () => {
        const handlers = extractInputHandlers(src);
        const handledKeys = Object.keys(handlers).filter((k) => k !== key).sort();
        expect(handledKeys).toEqual(expectedKeys);
      });

      test('input handlers navigate to correct screens', () => {
        const handlers = extractInputHandlers(src);
        for (const [k, dest] of Object.entries(handlers)) {
          if (k === key) continue; // own key is a no-op or escape, skip
          expect(dest).toBe(KEY_TO_SCREEN[k]);
        }
      });

      test(`does not navigate to self via number key`, () => {
        const handlers = extractInputHandlers(src);
        // If the screen handles its own key, it should NOT navigate to a different screen
        if (handlers[key]) {
          expect(handlers[key]).toBe(screen);
        }
      });
    });
  }
});
