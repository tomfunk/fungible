/**
 * Digit key -> screen id -> header text rendered by that screen. Pure data,
 * deliberately independent of tui/nav.tsx so a nav regression fails a test
 * instead of silently updating its own expectation.
 */
export interface ScreenNavEntry {
  digit: string;
  screen: string;
  header: string;
}

export const SCREEN_NAV: readonly ScreenNavEntry[] = [
  { digit: '0', screen: 'settings', header: 'Settings' },
  { digit: '1', screen: 'dashboard', header: 'Dashboard' },
  { digit: '2', screen: 'transactions', header: 'Transactions' },
  { digit: '3', screen: 'trends', header: 'Trends' },
  { digit: '4', screen: 'networth', header: 'Net Worth' },
  { digit: '5', screen: 'tags', header: 'Tags' },
  { digit: '6', screen: 'health', header: 'Financial Health' },
  { digit: '7', screen: 'rules', header: 'Tag Rules' },
  { digit: '8', screen: 'accounts', header: 'Accounts' },
  { digit: '9', screen: 'canvas', header: 'Canvas' },
];
