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
import { NetWorth } from '../../gui/renderer/src/screens/NetWorth.js';

beforeEach(async () => {
  for (const tbl of ['transactions', 'accounts', 'categories', 'tags', 'transaction_tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history',
                     'household_members']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
  installBridge();
});

afterEach(() => cleanup());

describe('GUI NetWorth', () => {
  it('lists assets and liabilities with balances', async () => {
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    expect(screen.getAllByText('$5,000.00').length).toBeGreaterThan(0); // asset row + total
    expect(screen.getByText('Test Visa')).toBeTruthy();
    expect(screen.getByText('Total assets')).toBeTruthy();
    expect(screen.getByText('Total debt')).toBeTruthy();
  });

  it('shows a signed big net worth number', async () => {
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    // sign prefix on the big number span proves fmtSigned path (balance rows are <td>)
    expect(screen.getByText(/^[+-]\$[\d,]+\.\d{2}$/, { selector: 'span' })).toBeTruthy();
  });

  it('group-by-type toggle switches to subtype rollups', async () => {
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'group by type' }));
    await waitFor(() => expect(screen.getByText('checking')).toBeTruthy());
    expect(screen.queryByText('Test Checking')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'show accounts' }));
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
  });

  it('shows history range pills when history exists', async () => {
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('History')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Month' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Year' })).toBeTruthy();
  });

  it('empty state without balance data', async () => {
    await db.execute('DELETE FROM balance_history');
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText(/No balance data yet/)).toBeTruthy());
  });

  it('carves excluded accounts into their own section, out of the headline total', async () => {
    await db.execute("INSERT INTO accounts (id, name, type, subtype, excluded) VALUES ('acct-529', 'College 529', 'investment', '529', 1)");
    await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('acct-529', 12345.00, '2026-05-20')");
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('Excluded (not in net worth)')).toBeTruthy());
    expect(screen.getByText('College 529')).toBeTruthy();
    expect(screen.getByText('+$12,345.00')).toBeTruthy(); // Excluded total (signed)
    // The 529 is an investment asset; were it counted, Total assets would read
    // $17,345.00 (5,000 + 12,345). It must stay out of the headline.
    expect(screen.queryByText('$17,345.00')).toBeNull();
  });

  it('omits the excluded section entirely when no account is excluded', async () => {
    renderScreen(<NetWorth />);
    await waitFor(() => expect(screen.getByText('Test Checking')).toBeTruthy());
    expect(screen.queryByText('Excluded (not in net worth)')).toBeNull();
  });
});
