import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Health } from '../../tui/Health.js';
import { Accounts } from '../../tui/Accounts.js';
import { waitFor, frame, flatFrame, pressKeys } from '../helpers/waitFor.js';
import { gateDb } from '../helpers/failingDb.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { W, MAY_FILTER, noop, useEmptyScreenDb } from './helpers/screenSetup.js';

useEmptyScreenDb();

type ScreenProps = { onNavigate: () => void; showHints: boolean };
const SCREENS: Record<string, React.ComponentType<ScreenProps>> = {
  Dashboard: (p) => <Dashboard {...p} initialFilter={MAY_FILTER} />,
  Transactions: (p) => <Transactions {...p} />,
  Trends: (p) => <Trends {...p} />,
  NetWorth: (p) => <NetWorth {...p} />,
  Tags: (p) => <Tags {...p} />,
  Rules: (p) => <Rules {...p} />,
  Health: (p) => <Health {...p} />,
  Accounts: (p) => <Accounts {...p} />,
};

function show(name: string) {
  const C = SCREENS[name];
  return render(<W><C onNavigate={noop} showHints={false} /></W>);
}

const SEEDED_NAMES = ['Whole Foods', 'Sweetgreen', 'Amazon', 'Test Checking', 'Test Visa', 'travel', 'work'];

// Each row: screen, strings that must appear once the (empty) load settles.
const EMPTY_COPY: Array<[string, string[]]> = [
  ['Dashboard', ['No expense data for this period.', '$0.00']],
  ['Transactions', []], // regex-checked below
  ['Trends', ['No data.']],
  ['NetWorth', ['No balance data yet.']],
  ['Tags', ['No tags yet. [a] to create one.', '0 tags']],
  ['Rules', ['No rules yet. [a] to add one.', '0 rules']],
  ['Health', ['no income found in transactions', 'need positive net worth']],
  ['Accounts', ['No accounts linked yet.']],
];

describe('empty database: every screen renders its empty state', () => {
  it.each(EMPTY_COPY)('%s', async (name, copy) => {
    const r = show(name);
    if (name === 'Transactions') {
      // not a substring check: "10 transactions" contains "0 transactions"
      await waitFor(() => expect(flatFrame(r)).toMatch(/(^|\s)0 transactions/));
    }
    for (const c of copy) await waitFor(() => expect(flatFrame(r)).toContain(c));
    const f = flatFrame(r);
    expect(f).not.toContain('Loading...');
    for (const n of SEEDED_NAMES) expect(f).not.toContain(n);
  });
});

async function count(table: string) {
  return Number((await db.execute(`SELECT COUNT(*) c FROM ${table}`)).rows[0].c);
}

describe('destructive/edit keys on an empty list are no-ops', () => {
  it.each([
    ['Tags', ['x', 'n', '\r', 't'], 'No tags yet. [a] to create one.'],
    ['Rules', ['x', '\r'], 'No rules yet. [a] to add one.'],
    ['Transactions', ['x', 'c', 'i', 'g', '\r', 'G'], '0 transactions'],
  ])('%s', async (name, keys, copy) => {
    const r = show(name);
    await waitFor(() => expect(flatFrame(r)).toContain(copy));
    await pressKeys(r, keys);
    await new Promise((res) => setTimeout(res, 100));
    expect(flatFrame(r)).toContain(copy);
    expect(frame(r)).not.toMatch(/Deleted|Rename|Override|Tagged|New Tag/);
    for (const t of ['tags', 'transaction_tags', 'transactions', 'category_rules', 'categories', 'hidden_categories']) {
      expect(await count(t)).toBe(0);
    }
  });
});

describe('Dashboard loading indicator', () => {
  it('shows Loading... while queries are in flight, then the data', async () => {
    await seedTuiData(db);
    const gate = gateDb(db);
    try {
      const r = show('Dashboard');
      await waitFor(() => expect(flatFrame(r)).toContain('Loading...'));
      expect(flatFrame(r)).not.toContain('SPENDING BY CATEGORY');
      gate.release();
      await waitFor(() => expect(flatFrame(r)).toContain('Grocery'));
      expect(flatFrame(r)).not.toContain('Loading...');
    } finally {
      gate.release();
      gate.restore();
    }
  });
});
