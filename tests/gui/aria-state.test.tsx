// @vitest-environment jsdom
// Active-state semantics: toggle-style pills/tabs/chips expose aria-pressed and
// the side nav exposes aria-current, so the active control is a behaviour, not a CSS class.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen, MAY_FILTER } from './helpers/renderGui.js';
import { Dashboard } from '../../gui/renderer/src/screens/Dashboard.js';
import { NetWorth } from '../../gui/renderer/src/screens/NetWorth.js';
import { Accounts } from '../../gui/renderer/src/screens/Accounts.js';
import { Rules } from '../../gui/renderer/src/screens/Rules.js';
import { Transactions } from '../../gui/renderer/src/screens/Transactions.js';
import { SideNav } from '../../gui/renderer/src/components/SideNav.js';
import { SCREEN_LABELS, SCREEN_ORDER } from '../../gui/shared/nav.js';

beforeEach(async () => {
  for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

const btn = (name: string | RegExp) => screen.getByRole('button', { name });
const pressed = (name: string | RegExp) => btn(name).getAttribute('aria-pressed');

// Asserts exactly `active` is pressed among `names`, then clicks each other
// control in turn and asserts the pressed state moves with it.
async function expectExclusive(names: (string | RegExp)[], active: number) {
  const check = (on: number) =>
    names.forEach((n, i) => expect(pressed(n), String(n)).toBe(i === on ? 'true' : 'false'));
  check(active);
  for (let i = 0; i < names.length; i++) {
    if (i === active) continue;
    await userEvent.click(btn(names[i]));
    check(i);
  }
}

describe('aria-pressed on active pills, tabs and chips', () => {
  it('Dashboard range pills', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await screen.findByText('$3,500.00');
    await expectExclusive(['Week', 'Month', '30 Days', 'Quarter', 'Year', 'All'], 1);
  });

  it('Dashboard view tabs', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await screen.findByText('$3,500.00');
    await expectExclusive(['Categories', 'Flexibility', 'Accounts'], 0);
  });

  it('Dashboard Scorecard and Baselines chips toggle', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await screen.findByText('$3,500.00');
    expect(pressed('Scorecard')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Baselines' })).toBeNull();
    await userEvent.click(btn('Scorecard'));
    expect(pressed('Scorecard')).toBe('true');
    expect(pressed('Baselines')).toBe('false');
    await userEvent.click(btn('Baselines'));
    expect(pressed('Baselines')).toBe('true');
    await userEvent.click(btn('Baselines'));
    expect(pressed('Baselines')).toBe('false');
  });

  it('Dashboard per-account filter button', async () => {
    renderScreen(<Dashboard />, { txFilter: MAY_FILTER });
    await screen.findByText('$3,500.00');
    await userEvent.click(btn('Accounts'));
    const filters = await screen.findAllByRole('button', { name: /filter/ });
    expect(filters.length).toBeGreaterThan(0);
    filters.forEach((f) => expect(f.getAttribute('aria-pressed')).toBe('false'));
    await userEvent.click(filters[0]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /filter/ })[0].getAttribute('aria-pressed')).toBe('true'));
    const after = screen.getAllByRole('button', { name: /filter/ });
    expect(after.filter((f) => f.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('NetWorth range pills', async () => {
    renderScreen(<NetWorth />);
    await screen.findByRole('button', { name: 'Quarter' });
    // Default range is month; Day is not offered as a button here.
    const names = ['Week', 'Month', 'Quarter', 'Year'];
    await expectExclusive(names, 1);
  });

  it('Accounts tabs', async () => {
    renderScreen(<Accounts />);
    await screen.findByRole('button', { name: 'Links' });
    await expectExclusive(['Accounts', 'Links', 'Add Data', /^Dupes/], 0);
  });

  it('Rules tabs', async () => {
    renderScreen(<Rules />);
    await screen.findByRole('button', { name: /^Rules \(/ });
    await expectExclusive([/^Rules \(/, /^Tag rules \(/, /^Categories \(/], 0);
  });

  it('Transactions Expense/Income pills', async () => {
    renderScreen(<Transactions />);
    await waitFor(() => expect(screen.getByText('9 transactions')).toBeTruthy());
    await userEvent.click(btn('+ Add'));
    await screen.findByText('Add transaction');
    await expectExclusive(['Expense', 'Income'], 0);
  });
});

describe('SideNav aria-current', () => {
  it.each(SCREEN_ORDER)('marks only %s as the current page', async (active) => {
    render(<SideNav active={active} onSelect={() => {}} />);
    for (const s of SCREEN_ORDER) {
      const b = screen.getByRole('button', { name: new RegExp(`^${SCREEN_LABELS[s]}`) });
      expect(b.getAttribute('aria-current')).toBe(s === active ? 'page' : null);
    }
  });
});
