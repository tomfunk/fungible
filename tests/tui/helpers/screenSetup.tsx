import React from 'react';
import { beforeEach, afterEach, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { db } from '../../../core/db.js';
import { seedTuiData } from '../../helpers/seedTuiData.js';
import { loadProfile } from '../../../core/profile.js';
import { RefreshProvider } from '../../../tui/RefreshContext.js';
import { TypingContext } from '../../../tui/TypingContext.js';

/**
 * Shared setup for the per-screen TUI test files.
 *
 * Each test file must still declare its own `vi.mock('../../core/db.js', ...)`
 * (makeTestDb) and `vi.mock('../../core/profile.js', ...)` (loadProfile as a
 * vi.fn) at the top: vi.mock is hoisted per file and cannot live in a helper.
 */

/** Stand-in for the scripts/link.ts child: emit on .stdout/.stderr to drive the panel. */
export function fakeLinkProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

/** Wraps a screen in the providers App normally supplies. */
export function W({ children }: { children: React.ReactNode }) {
  return (
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        {children}
      </TypingContext.Provider>
    </RefreshProvider>
  );
}

// Anchor all tests to May 2026 so they hit the seeded data regardless of real date.
export const MAY_FILTER = { range: 'month' as const, anchor: '2026-05-15' };
export const noop = () => {};

/** Registers the standard per-test reset: wipe tables, reseed, and unmount after. */
export function useSeededScreenDb(): void {
  beforeEach(async () => {
    vi.mocked(loadProfile).mockResolvedValue(null); // no household members unless a test sets one
    for (const tbl of ['transaction_tags', 'tag_rule_suppressions', 'transactions', 'accounts', 'categories', 'tags',
                       'category_rules', 'name_rules', 'hidden_categories', 'balance_history', 'settings']) {
      await db.execute(`DELETE FROM ${tbl}`);
    }
    await seedTuiData(db);
  });
  afterEach(() => cleanup());
}
