// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { installBridge, renderScreen } from './helpers/renderGui.js';
import { Trends } from '../../gui/renderer/src/screens/Trends.js';

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

// Recharts' ResponsiveContainer renders nothing at jsdom's zero size, so these
// tests assert the surrounding UI (selector, pills, stats), not SVG internals.
describe('GUI Trends', () => {
  it('loads trend views into the selector', async () => {
    renderScreen(<Trends />);
    const select = await screen.findByRole('combobox');
    const labels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toContain('Expenses');
    expect(labels).toContain('Income');
    expect(labels).toContain('Net');
    expect(labels).toContain('Flexibility');
  });

  it('shows range pills and stats cards', async () => {
    renderScreen(<Trends />);
    await screen.findByRole('combobox');
    expect(screen.getByRole('button', { name: 'Week' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quarter' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Periods')).toBeTruthy());
    expect(screen.getByText('Avg / month')).toBeTruthy();
  });

  // Search now lives in the shared FilterBar (mounted once above
  // Dashboard/Transactions/Trends in the real app), not in Trends itself —
  // renderScreen's filterBar:true mounts it here too so these can drive it.
  it('search shows live transaction match count', async () => {
    renderScreen(<Trends />, { filterBar: true });
    await screen.findByRole('combobox');
    await userEvent.type(screen.getByPlaceholderText('Search transactions…'), 'Whole');
    await waitFor(() => expect(screen.getByText(/2 txns/)).toBeTruthy());
  });

  it('search switches to matching periods', async () => {
    renderScreen(<Trends />, { filterBar: true });
    await screen.findByRole('combobox');
    const input = screen.getByPlaceholderText('Search transactions…');
    await userEvent.type(input, 'Whole');
    await waitFor(() => expect(screen.getByText(/2 periods/)).toBeTruthy());
    await userEvent.click(screen.getByText('clear'));
    await waitFor(() => expect(screen.queryByText(/2 periods/)).toBeNull());
  });

  it('peak card navigates to that period’s transactions', async () => {
    const navigate = vi.fn();
    renderScreen(<Trends />, { navigate });
    await waitFor(() => expect(screen.getByText('Peak')).toBeTruthy());
    await userEvent.click(screen.getByText('Peak'));
    expect(navigate).toHaveBeenCalledWith(
      'transactions',
      expect.objectContaining({ from: '2026-05-01', txType: 'expenses' }),
    );
  });

  it('honors an initial category filter by selecting that view', async () => {
    renderScreen(<Trends />, { txFilter: { focusCategory: 'Grocery' } });
    const select = await screen.findByRole('combobox');
    await waitFor(() => {
      const selected = (select as HTMLSelectElement).selectedOptions[0]?.textContent;
      expect(selected).toBe('Grocery');
    });
  });

  it('chart type toggle defaults to Bars and switches to Line, updating the hint', async () => {
    renderScreen(<Trends />);
    await screen.findByRole('combobox');
    const barsBtn = await screen.findByRole('button', { name: 'Bars' });
    const lineBtn = screen.getByRole('button', { name: 'Line' });
    expect(barsBtn.className).toContain('pillActive');
    expect(lineBtn.className).not.toContain('pillActive');
    await waitFor(() => expect(screen.getByText(/Click a bar/)).toBeTruthy());

    await userEvent.click(lineBtn);
    expect(lineBtn.className).toContain('pillActive');
    expect(barsBtn.className).not.toContain('pillActive');
    await waitFor(() => expect(screen.getByText(/Click a point/)).toBeTruthy());
  });

  it('hides the chart type toggle for the stacked Flexibility breakdown view', async () => {
    renderScreen(<Trends />);
    const select = await screen.findByRole('combobox');
    expect(screen.getByRole('button', { name: 'Line' })).toBeTruthy();

    await userEvent.selectOptions(select, 'Flexibility');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Line' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Bars' })).toBeNull();

    // Switching back to a non-stacked view brings the toggle back, defaulted to Bars.
    await userEvent.selectOptions(select, 'Expenses');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Line' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Bars' }).className).toContain('pillActive');
  });
});
