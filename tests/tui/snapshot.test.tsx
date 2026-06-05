/**
 * Snapshot capture test — renders every screen with seeded data and prints
 * lastFrame() to a deterministic output file for cross-branch diffing.
 *
 * Usage:
 *   npx vitest run tests/tui/snapshot.test.tsx 2>/dev/null | tee /tmp/snapshot-feat.txt
 * Then on main:
 *   npx vitest run tests/tui/snapshot.test.tsx 2>/dev/null | tee /tmp/snapshot-main.txt
 * Then:
 *   diff /tmp/snapshot-main.txt /tmp/snapshot-feat.txt
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { vi } from 'vitest';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { seedTuiData } from '../helpers/seedTuiData.js';
import { Dashboard } from '../../tui/Dashboard.js';
import { Transactions } from '../../tui/Transactions.js';
import { Trends } from '../../tui/Trends.js';
import { NetWorth } from '../../tui/NetWorth.js';
import { Tags } from '../../tui/Tags.js';
import { Rules } from '../../tui/Rules.js';
import { Accounts } from '../../tui/Accounts.js';
import { Health } from '../../tui/Health.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
function frame(r: ReturnType<typeof render>): string {
  return (r.lastFrame() ?? '').replace(ANSI_RE, '');
}
async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}
function W({ children }: { children: React.ReactNode }) {
  return (
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        {children}
      </TypingContext.Provider>
    </RefreshProvider>
  );
}
const MAY_FILTER = { range: 'month' as const, anchor: '2026-05-15' };
const noop = () => {};

beforeEach(async () => {
  for (const tbl of ['transactions', 'accounts', 'categories', 'tags', 'transaction_tags',
                     'category_rules', 'name_rules', 'hidden_categories', 'balance_history']) {
    await db.execute(`DELETE FROM ${tbl}`);
  }
  await seedTuiData(db);
});
afterEach(() => cleanup());

function dump(name: string, output: string) {
  const lines = output.split('\n');
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SCREEN: ${name}`);
  console.log('='.repeat(60));
  for (const line of lines) console.log(line);
}

describe('snapshots', () => {
  it('dashboard', async () => {
    const r = render(<W><Dashboard onNavigate={noop} showHints isActive initialFilter={MAY_FILTER} /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('fungible')) throw new Error(); });
    await waitFor(() => { if (!r.lastFrame()?.includes('Income')) throw new Error(); });
    dump('dashboard', frame(r));
  });

  it('transactions', async () => {
    const r = render(<W><Transactions onNavigate={noop} showHints isActive initialFilter={MAY_FILTER} /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Transactions')) throw new Error(); });
    await waitFor(() => { if (!r.lastFrame()?.includes('DATE')) throw new Error(); });
    dump('transactions', frame(r));
  });

  it('trends', async () => {
    const r = render(<W><Trends onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Trends')) throw new Error(); });
    await waitFor(() => { if (!r.lastFrame()?.includes('Month')) throw new Error(); });
    dump('trends', frame(r));
  });

  it('networth', async () => {
    const r = render(<W><NetWorth onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Net Worth')) throw new Error(); });
    dump('networth', frame(r));
  });

  it('tags', async () => {
    const r = render(<W><Tags onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Tags')) throw new Error(); });
    dump('tags', frame(r));
  });

  it('health', async () => {
    const r = render(<W><Health onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Financial Health')) throw new Error(); });
    dump('health', frame(r));
  });

  it('rules', async () => {
    const r = render(<W><Rules onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('rules')) throw new Error(); });
    dump('rules', frame(r));
  });

  it('accounts', async () => {
    const r = render(<W><Accounts onNavigate={noop} showHints isActive /></W>);
    await waitFor(() => { if (!r.lastFrame()?.includes('Accounts')) throw new Error(); });
    dump('accounts', frame(r));
  });
});
