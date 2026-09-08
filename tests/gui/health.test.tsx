// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Health } from '../../gui/renderer/src/screens/Health.js';

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

describe('GUI Health', () => {
  it('renders cash flow, retirement sections and stat cards', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Cash Flow')).toBeTruthy());
    expect(screen.getByText('Retirement')).toBeTruthy();
    expect(screen.getByText('Monthly income')).toBeTruthy();
    expect(screen.getByText('Savings rate')).toBeTruthy();
    expect(screen.getByText('Cash runway')).toBeTruthy();
    expect(screen.getByText('FIRE spend')).toBeTruthy();
    expect(screen.getByText('Coast FIRE')).toBeTruthy();
    // Stat cards
    expect(screen.getByText('Savings Rate')).toBeTruthy();
    expect(screen.getByText('Net Worth')).toBeTruthy();
    expect(screen.getByText('Years to FIRE')).toBeTruthy();
  });

  it('breaks debt into credit cards, loans and a combined total when a loan account exists', async () => {
    await db.execute("UPDATE balance_history SET balance = 450.00 WHERE account_id = 'test-credit'");
    await db.execute("INSERT INTO accounts (id, name, type, subtype, institution_name, mask) VALUES ('test-mortgage', 'Home Loan', 'loan', 'mortgage', 'Test Bank', '0003')");
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('test-mortgage', 300000.00, '2026-05-20')");
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Credit cards')).toBeTruthy());
    expect(screen.getByText('Loans')).toBeTruthy();
    // Combined-total row
    const totalRow = screen.getByText('Total').closest('div')!;
    expect(totalRow.textContent).toContain('subtracted from net worth');
    // The single generic "Debt" row is not rendered once the breakdown shows
    expect(screen.queryByText('Debt')).toBeNull();
  });

  it('shows a single Debt row when there is no loan debt', async () => {
    await db.execute("UPDATE balance_history SET balance = 450.00 WHERE account_id = 'test-credit'");
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Debt')).toBeTruthy());
    expect(screen.queryByText('Loans')).toBeNull();
  });

  it('renders the four assumption dials', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Monthly spending')).toBeTruthy());
    expect(screen.getByText('Monthly savings')).toBeTruthy();
    expect(screen.getByText('Withdrawal rate')).toBeTruthy();
    expect(screen.getByText('Growth rate')).toBeTruthy();
  });

  it('spending stepper adjusts by $100 and shows reset when modified', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Monthly spending')).toBeTruthy());
    const spendDial = screen.getByText('Monthly spending').closest('div')!.parentElement!;
    const before = (spendDial.querySelector('input[type="number"]') as HTMLInputElement).value;
    const plus = Array.from(spendDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    const after = (spendDial.querySelector('input[type="number"]') as HTMLInputElement).value;
    expect(Number(after)).toBe(Number(before) + 100);
    expect(spendDial.textContent).toContain('reset');
    await userEvent.click(Array.from(spendDial.querySelectorAll('button')).find((b) => b.textContent === 'reset')!);
    const restored = (spendDial.querySelector('input[type="number"]') as HTMLInputElement).value;
    expect(restored).toBe(before);
  });

  it('withdrawal slider changes the FIRE target', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Cash Flow')).toBeTruthy());
    // "Net worth" metric in Retirement panel shows "X% of FIRE target" — changes with withdrawal rate
    const netWorthRow = screen.getByText('Net worth').closest('div')!;
    const before = netWorthRow.textContent;
    const wDial = screen.getByText('Withdrawal rate').closest('div')!.parentElement!;
    const slider = wDial.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '8' } });
    await waitFor(() => {
      const after = screen.getByText('Net worth').closest('div')!.textContent;
      expect(after).not.toBe(before);
    });
  });
});
