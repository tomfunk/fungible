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
    // 'Retirement' also names a History metric pill once history renders, so
    // scope to the panel heading to disambiguate.
    expect(screen.getByRole('heading', { name: 'Retirement' })).toBeTruthy();
    expect(screen.getByText('Monthly income')).toBeTruthy();
    expect(screen.getByText('Savings rate')).toBeTruthy();
    expect(screen.getByText('Cash runway')).toBeTruthy();
    expect(screen.getByText('FIRE spend')).toBeTruthy();
    // 'Coast FIRE', 'Savings Rate' and 'Years to FIRE' also name History
    // metric pills once history renders — just confirm they appear somewhere.
    expect(screen.getAllByText('Coast FIRE').length).toBeGreaterThan(0);
    // Stat cards
    expect(screen.getAllByText('Savings Rate').length).toBeGreaterThan(0);
    expect(screen.getByText('Net Worth')).toBeTruthy();
    expect(screen.getAllByText('Years to FIRE').length).toBeGreaterThan(0);
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
    // Dollar dial, unfocused throughout this test -> comma-formatted text, not
    // a type="number" input; strip commas before comparing as numbers.
    const spendInput = () => spendDial.querySelector('input') as HTMLInputElement;
    const parse = (s: string) => Number(s.replace(/,/g, ''));
    const before = spendInput().value;
    const plus = Array.from(spendDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    const after = spendInput().value;
    expect(parse(after)).toBe(parse(before) + 100);
    expect(spendDial.textContent).toContain('reset');
    await userEvent.click(Array.from(spendDial.querySelectorAll('button')).find((b) => b.textContent === 'reset')!);
    const restored = spendInput().value;
    expect(restored).toBe(before);
  });

  it('the spending dial shows raw digits while focused and comma-formats on blur', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Monthly spending')).toBeTruthy());
    const spendDial = screen.getByText('Monthly spending').closest('div')!.parentElement!;
    const input = spendDial.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toMatch(/^-?[\d,]+$/);

    fireEvent.focus(input);
    expect(input.type).toBe('number');
    expect(input.value).not.toContain(',');

    fireEvent.change(input, { target: { value: '4200' } });
    expect(input.value).toBe('4200');

    fireEvent.blur(input);
    expect(input.type).toBe('text');
    expect(input.value).toBe('4,200');
  });

  it('withdrawal rate stepper changes the FIRE target', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Cash Flow')).toBeTruthy());
    // "Net worth" metric in Retirement panel shows "X% of FIRE target" — changes with withdrawal rate
    const netWorthRow = screen.getByText('Net worth').closest('div')!;
    const before = netWorthRow.textContent;
    const wDial = screen.getByText('Withdrawal rate').closest('div')!.parentElement!;
    const input = wDial.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8' } });
    await waitFor(() => {
      const after = screen.getByText('Net worth').closest('div')!.textContent;
      expect(after).not.toBe(before);
    });
  });

  it('growth rate steps by 1.0 (matching TUI), not 0.5', async () => {
    renderScreen(<Health />);
    await waitFor(() => expect(screen.getByText('Growth rate')).toBeTruthy());
    const gDial = screen.getByText('Growth rate').closest('div')!.parentElement!;
    const before = (gDial.querySelector('input[type="number"]') as HTMLInputElement).value;
    const plus = Array.from(gDial.querySelectorAll('button')).find((b) => b.textContent === '+')!;
    await userEvent.click(plus);
    const after = (gDial.querySelector('input[type="number"]') as HTMLInputElement).value;
    expect(Number(after)).toBe(Number(before) + 1);
  });

  describe('History', () => {
    it('renders a History section with range and metric pills, defaulting to Savings Rate', async () => {
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
      expect(screen.getByRole('button', { name: 'Month' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Year' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Savings Rate' }).className).toBe('pillActive');
      expect(screen.getByRole('button', { name: 'Cash Runway' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Liquid Runway' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Debt Payoff' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Retirement Balance' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Years to FIRE' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Coast FIRE' })).toBeTruthy();
    });

    it('selecting a metric pill marks it active', async () => {
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Retirement Balance' }));
      expect(screen.getByRole('button', { name: 'Retirement Balance' }).className).toBe('pillActive');
      expect(screen.getByRole('button', { name: 'Savings Rate' }).className).toBe('pill');
    });

    it('shows the live-assumptions caption only for Years to FIRE / Coast FIRE', async () => {
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
      expect(screen.queryByText(/today's growth\/withdrawal-rate assumptions/)).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Years to FIRE' }));
      await waitFor(() => expect(screen.getByText(/today's growth\/withdrawal-rate assumptions/)).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: 'Coast FIRE' }));
      expect(screen.getByText(/today's growth\/withdrawal-rate assumptions/)).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Retirement Balance' }));
      expect(screen.queryByText(/today's growth\/withdrawal-rate assumptions/)).toBeNull();
    });

    it('switching the range pill marks the new range active', async () => {
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
      await userEvent.click(screen.getByRole('button', { name: 'Year' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Year' }).className).toBe('pillActive'));
      expect(screen.getByRole('button', { name: 'Month' }).className).toBe('pill');
    });

    it('omits the History section when there is no balance history', async () => {
      await db.execute('DELETE FROM balance_history');
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('Cash Flow')).toBeTruthy());
      expect(screen.queryByText('History')).toBeNull();
    });

    it('renders above the Assumptions panel, not below it', async () => {
      renderScreen(<Health />);
      await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
      const historyLabel = screen.getByText('History');
      const assumptionsHeading = screen.getByText('Assumptions');
      // Node.DOCUMENT_POSITION_FOLLOWING (4): assumptionsHeading comes after historyLabel.
      expect(historyLabel.compareDocumentPosition(assumptionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
