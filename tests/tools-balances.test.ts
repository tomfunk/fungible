import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { executeTool } from '../core/tools.js';
import { getBalances } from '../core/agent-context.js';

beforeEach(async () => {
  await db.execute('DELETE FROM accounts');
  await db.execute('DELETE FROM balance_history');
  // A counted checking account and an excluded 529.
  await db.execute("INSERT INTO accounts (id, name, type, subtype, institution_name, mask, excluded) VALUES ('chk', 'Test Checking', 'depository', 'checking', 'Test Bank', '0001', 0)");
  await db.execute("INSERT INTO accounts (id, name, type, subtype, institution_name, mask, excluded) VALUES ('acct-529', 'College 529', 'investment', '529', 'Fidelity', '5290', 1)");
  await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('chk', 5000.00, '2026-05-20')");
  await db.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('acct-529', 60000.00, '2026-05-20')");
});

describe('getBalances with an excluded account', () => {
  it('keeps the excluded account out of totals but returns it separately', async () => {
    const b = await getBalances();
    expect(b.accounts.map((a) => a.name)).toEqual(['Test Checking']);
    expect(b.excludedAccounts.map((a) => a.name)).toEqual(['College 529']);
    expect(b.totalAssets).toBe(5000);   // 529 not counted
    expect(b.netWorth).toBe(5000);
  });
});

describe('get_balances tool output', () => {
  it('shows a carved-out "Excluded" section and leaves net worth untouched', async () => {
    const out = await executeTool('get_balances', {});
    expect(out).toContain('Total assets: $5,000.00');
    expect(out).toContain('Net worth: $5,000.00');
    expect(out).toContain('Excluded (not in net worth):');
    expect(out).toContain('College 529: $60,000.00 (529)');
    // The 529 must never roll into the headline ($65,000.00 would mean it leaked).
    expect(out).not.toContain('$65,000.00');
  });
});

describe('list_accounts tool output', () => {
  it('tags excluded accounts, leaving counted ones unmarked', async () => {
    const out = await executeTool('list_accounts', {});
    const lines = out.split('\n');
    expect(lines.find((l) => l.startsWith('College 529'))).toContain('· excluded from net worth');
    expect(lines.find((l) => l.startsWith('Test Checking'))).not.toContain('excluded from net worth');
  });
});
