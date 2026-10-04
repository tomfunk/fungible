import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});
vi.mock('../../core/canvas-history.js', () => ({
  loadHistory: vi.fn(() => []),
  deleteHistoryEntry: vi.fn(() => true),
  updateHistoryEntrySpec: vi.fn(),
  resolveAndWriteCanvasSpec: vi.fn(async (s: unknown) => s),
}));

import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts } from '../../tui/Accounts.js';
import { Health } from '../../tui/Health.js';
import { Canvas, type LoadedCanvasSpec } from '../../tui/Canvas.js';
import { Settings } from '../../tui/Settings.js';
import { db } from '../../core/db.js';
import { FilterProvider } from '../../tui/FilterContext.js';
import { waitFor, stripAnsi } from '../helpers/waitFor.js';
import { W, MAY_FILTER, noop, useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAtWidth } from './helpers/renderAtWidth.js';

useSeededScreenDb();

const SPEC: LoadedCanvasSpec = {
  title: 'Narrow Canvas',
  elements: [
    { type: 'dial', dial: { key: 'a', label: 'Monthly contribution', default: 500, step: 50, min: 0, format: 'dollar', hint: 'how much per month' } },
  ],
} as LoadedCanvasSpec;

// ink-testing-library fixes the terminal at 100 columns, so these tests mount each
// screen through renderAtWidth. Layout helpers in tui/fmt.tsx size dividers off
// process.stdout.columns (not Ink's stdout), so the width is mirrored there too —
// otherwise the 76-char dividers would wrap at every width and say nothing.
//
// Contract pinned here: at every width a screen mounts without throwing, keeps its
// title, never emits a line wider than the terminal, and still shows its primary
// datum and footer hint. Cases that are genuinely broken at a width are pinned with
// it.fails (reason in the comment) so a layout fix flips them red-to-green and
// forces the pin to be removed, instead of the assertion being loosened.

interface ScreenCase {
  name: string;
  mk: () => React.ReactElement;
  title: string;
  /** Appears in the seeded data; must sit on one line at every width. */
  datum: string;
  /** Footer/hint snippet, checked on whitespace-collapsed text (hints wrap on words). */
  hint: string;
}

const SCREENS: ScreenCase[] = [
  { name: 'Dashboard', mk: () => <Dashboard onNavigate={noop} showHints initialFilter={MAY_FILTER} />, title: 'Dashboard', datum: 'Grocery', hint: '[S] sync' },
  { name: 'Transactions', mk: () => <Transactions onNavigate={noop} showHints initialFilter={MAY_FILTER} />, title: 'Transactions', datum: '9 transactions', hint: '[e] export' },
  { name: 'Trends', mk: () => <Trends onNavigate={noop} showHints />, title: 'Trends', datum: '$388.99', hint: '[S] sync' },
  { name: 'NetWorth', mk: () => <NetWorth onNavigate={noop} showHints />, title: 'Net Worth', datum: 'Test Checking', hint: '↑↓ scroll' },
  { name: 'Tags', mk: () => <Tags onNavigate={noop} showHints />, title: 'Tags', datum: 'travel', hint: '[t] transactions' },
  { name: 'Rules', mk: () => <Rules onNavigate={noop} showHints />, title: 'Rules', datum: '1 rules', hint: '[Tab] switch' },
  { name: 'Accounts', mk: () => <Accounts onNavigate={noop} showHints />, title: 'Accounts', datum: '2 accounts', hint: '[s] sync' },
  { name: 'Health', mk: () => <Health onNavigate={noop} showHints />, title: 'Financial Health', datum: '$5,450.00', hint: '[t] history' },
  { name: 'Canvas', mk: () => <Canvas onNavigate={noop} onLoadSpec={noop} showHints spec={SPEC} specKey={0} />, title: 'Canvas', datum: 'Narrow Canvas', hint: '[/] history' },
  { name: 'Settings', mk: () => <Settings onNavigate={noop} showHints />, title: 'Settings', datum: 'HOUSEHOLD', hint: 'Esc back' },
];
const byName = (n: string) => SCREENS.find((c) => c.name === n)!;

const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
afterEach(() => {
  if (savedColumns) Object.defineProperty(process.stdout, 'columns', savedColumns);
  else delete (process.stdout as { columns?: number }).columns;
});

async function mount(c: ScreenCase, width: number, datum = c.datum) {
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  const r = renderAtWidth(width, <W><FilterProvider>{c.mk()}</FilterProvider></W>);
  const text = () => stripAnsi(r.lastFrame());
  await waitFor(() => expect(text()).toContain(datum), { timeout: 3000, context: text });
  const lines = () => text().split('\n');
  return { ...r, text, lines, flat: () => text().replace(/\s+/g, ' ') };
}

describe.each([80, 60, 40])('narrow terminal: %i columns', (width) => {
  it.each(SCREENS)('$name renders, keeps its title, fits the width and keeps datum + hint', async (c) => {
    const m = await mount(c, width);
    // Accounts' tab bar splits its own title at 40 columns: pinned below.
    if (!(c.name === 'Accounts' && width === 40)) {
      expect(m.lines().some((l) => l.includes(c.title)), `title "${c.title}" on one line`).toBe(true);
    }
    const over = m.lines().filter((l) => l.length > width);
    expect(over, 'lines wider than the terminal').toEqual([]);
    expect(m.flat()).toContain(c.hint);
    m.unmount();
  }, 10000);
});

// ─── Known-broken layouts, pinned ──────────────────────────────────────────────
// Each of these fails today; it.fails keeps them honest. Remove the `.fails` when
// the layout is fixed.

describe('known narrow-width defects (pinned with it.fails)', () => {
  // PageHeader: the "fungible" wordmark and the nav hints share one flex row with no
  // minimum width on the wordmark, so at 40 columns the hints (4 lines) squeeze it
  // into "fungibl" / "e". It stays whole at 60 and 80.
  it.fails.each(SCREENS.map((c) => c.name))('%s: the fungible wordmark stays on one line at 40 columns', async (name) => {
    const m = await mount(byName(name), 40);
    expect(m.lines().some((l) => /^\s*fungible(\s|$)/.test(l))).toBe(true);
    m.unmount();
  }, 10000);

  // Accounts' sub-tab bar wraps its first tab: "Account" / "s" at 40 columns.
  it.fails('Accounts: the "Accounts" tab label is not split at 40 columns', async () => {
    const m = await mount(byName('Accounts'), 40);
    expect(m.lines().some((l) => l.includes('Accounts'))).toBe(true);
    m.unmount();
  });

  // Table rows: every cell is a fixed/flex Box that wraps instead of truncating once
  // the row no longer fits, so one record spreads over 2-3 lines with cells
  // interleaved (dates broken at the hyphen, "-$120" / ".00", "Checki" / "ng").
  // `parts` must all land on one line. Each also passes at the wider width (control).
  const ROWS: Array<{ screen: string; width: number; parts: Array<string | RegExp> }> = [
    { screen: 'Transactions', width: 40, parts: ['2026-05-06', 'Whole Foods', '-$120.00', 'Grocery'] },
    { screen: 'Tags', width: 60, parts: ['travel', '0 tx', /\$0\.00.*\$0\.00/] },
    { screen: 'Tags', width: 40, parts: ['travel', '0 tx', /\$0\.00.*\$0\.00/] },
    { screen: 'Accounts', width: 60, parts: ['Test Checking', 'checking'] },
    { screen: 'Accounts', width: 40, parts: ['Test Checking', 'checking'] },
    { screen: 'NetWorth', width: 40, parts: ['Test Checking', '$5,000.00'] },
    { screen: 'Rules', width: 40, parts: ['Whole Foods', 'Grocery'] },
    { screen: 'Dashboard', width: 40, parts: ['$3,500.00'] },
  ];
  const oneLine = async (screen: string, width: number, parts: Array<string | RegExp>) => {
    const m = await mount(byName(screen), width);
    const hit = m.lines().find((l) => parts.every((p) => (typeof p === 'string' ? l.includes(p) : p.test(l))));
    m.unmount();
    expect(hit, `${parts.join(' | ')} on one line`).toBeDefined();
  };
  it.fails.each(ROWS)('$screen: record stays on one line at $width columns ($parts)', async ({ screen, width, parts }) => {
    await oneLine(screen, width, parts);
  }, 10000);
  // Widest-but-still-narrow width at which the record is known to be intact.
  const CONTROL_WIDTH: Record<string, number> = { Tags: 80, Accounts: 80 };
  it.each(ROWS.filter((r, i, a) => a.findIndex((x) => x.screen === r.screen) === i).map((r) => ({ ...r, ctl: CONTROL_WIDTH[r.screen] ?? 60 })))(
    '$screen: control - the same record is on one line at $ctl columns', async ({ screen, parts }) => {
      await oneLine(screen, CONTROL_WIDTH[screen] ?? 60, parts);
    }, 10000);

  // DialRow keeps a fixed 12-wide value column; whenever the terminal squeezes it
  // the value is middle-truncated and the LEADING digits are the ones dropped
  // ("$100.00" -> "…0.00", "$500" -> "…00" -> bare "…"), so an editable dollar
  // amount is unreadable. Already broken at 80 columns (the default terminal).
  const dialValuesReadable = async (screen: string, width: number) => {
    const m = await mount(byName(screen), width, screen === 'Health' ? 'ASSUMPTIONS' : 'Narrow Canvas');
    const t = m.text();
    m.unmount();
    expect(t).not.toMatch(/\[\s*\+?…/);
  };
  it.fails.each([['Health', 80], ['Health', 60], ['Health', 40], ['Canvas', 80], ['Canvas', 60], ['Canvas', 40]] as const)(
    '%s: dial values are not ellipsized at %i columns', async (screen, width) => {
      await dialValuesReadable(screen, width);
    }, 10000);
  it.each([['Health', 100], ['Canvas', 100]] as const)(
    '%s: control - dial values are intact at 100 columns', async (screen, width) => {
      await dialValuesReadable(screen, width);
    }, 10000);
});

// ─── Long names at 40 columns ──────────────────────────────────────────────────

describe('40 columns with very long names', () => {
  const LONG = 'Zyxel Extraordinarily Long Name That Cannot Possibly Fit In A Forty Column Terminal';
  beforeEach(async () => {
    await db.batch([
      `INSERT INTO accounts (id, name, type, subtype, institution_name, mask) VALUES ('long-acct', '${LONG} Account', 'depository', 'checking', '${LONG} Bank', '9999')`,
      `INSERT INTO balance_history (account_id, balance, date) VALUES ('long-acct', 1234567.89, '2026-05-20')`,
      `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES ('tx-long', 'long-acct', '2026-05-20', '${LONG} Merchant', 98765.43, '${LONG} Category', 0, 0)`,
      `INSERT INTO tags (id, name) VALUES (9, 'zyx-${LONG.replace(/ /g, '-')}')`,
      `INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (5, 'name', '${LONG}', '${LONG} Category')`,
    ], 'write');
  });

  const LONG_DATUM: Record<string, string> = { Trends: 'Expenses', Health: 'ASSUMPTIONS' };
  // Title is checked per screen; Accounts' title is split at 40 (pinned above).
  it.each(SCREENS)('$name does not throw, stays within 40 columns and shows the start of the long name', async (c) => {
    const needle = ({ Transactions: 'Zyx', Dashboard: 'Zyx', NetWorth: 'Zyx', Tags: 'zyx', Rules: 'Zyx', Accounts: 'Zyx' } as Record<string, string>)[c.name];
    const m = await mount(c, 40, needle ?? LONG_DATUM[c.name] ?? c.datum);
    expect(m.lines().filter((l) => l.length > 40)).toEqual([]);
    if (c.name !== 'Accounts') expect(m.lines().some((l) => l.includes(c.title))).toBe(true);
    m.unmount();
  }, 10000);
});
