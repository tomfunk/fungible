import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../core/plaid.js', () => ({
  getPlaidClient: vi.fn(),
  plaidErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../core/crypto.js', () => ({
  decryptToken: (v: string) => `decrypted:${v}`,
  encryptToken: (v: string) => v,
}));

// The poll's job is deciding *when* to sync and what to report; syncTransactions
// has its own coverage in sync.test.ts. describeSyncProgress stays real so the
// progress passthrough is exercised for what it actually renders.
vi.mock('../core/sync.js', async (importActual) => {
  const actual = await importActual<typeof import('../core/sync.js')>();
  return { ...actual, syncTransactions: vi.fn() };
});

import { db } from '../core/db.js';
import { getPlaidClient } from '../core/plaid.js';
import { syncTransactions } from '../core/sync.js';
import {
  refreshTransactions, describeRefreshResult, describeRefreshProgress,
  POLL_DELAYS_MS, type RefreshProgress,
} from '../core/transactions-refresh.js';

const ITEM = 'item-1';

/** No transactions found — what every check returns until one doesn't. */
const nothing = { added: 0, modified: 0, removed: 0, dupes: 0 };

let transactionsRefresh: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  await db.execute('DELETE FROM plaid_items');
  await db.execute({
    sql: `INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`,
    args: [ITEM, 'token-1', 'Test Bank'],
  });
  transactionsRefresh = vi.fn().mockResolvedValue({ data: { request_id: 'req-1' } });
  vi.mocked(getPlaidClient).mockReturnValue({ transactionsRefresh } as never);
  vi.mocked(syncTransactions).mockResolvedValue(nothing);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Runs `p` to completion, advancing past every poll delay it waits on. */
async function runPoll<T>(p: Promise<T>): Promise<T> {
  for (const ms of POLL_DELAYS_MS) await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe('refreshTransactions', () => {
  it('sends the decrypted access token to /transactions/refresh exactly once', async () => {
    const result = await runPoll(refreshTransactions(ITEM));

    expect(transactionsRefresh).toHaveBeenCalledTimes(1);
    expect(transactionsRefresh).toHaveBeenCalledWith({ access_token: 'decrypted:token-1' });
    expect(result.error).toBeUndefined();
  });

  it('stops checking as soon as a sync returns something', async () => {
    vi.mocked(syncTransactions)
      .mockResolvedValueOnce(nothing)
      .mockResolvedValueOnce({ added: 3, modified: 1, removed: 0, dupes: 0 });

    const result = await runPoll(refreshTransactions(ITEM));

    expect(syncTransactions).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ added: 3, modified: 1, checks: 2, cancelled: false });
  });

  it('counts a pending → posted update as something landing', async () => {
    vi.mocked(syncTransactions).mockResolvedValueOnce({ added: 0, modified: 2, removed: 0, dupes: 0 });

    const result = await runPoll(refreshTransactions(ITEM));

    expect(syncTransactions).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ added: 0, modified: 2, checks: 1 });
  });

  it('gives up after the last delay when nothing ever arrives', async () => {
    const result = await runPoll(refreshTransactions(ITEM));

    expect(syncTransactions).toHaveBeenCalledTimes(POLL_DELAYS_MS.length);
    expect(result).toMatchObject({ added: 0, checks: POLL_DELAYS_MS.length, cancelled: false });
    expect(result.error).toBeUndefined();
  });

  it('waits the full backoff between checks', async () => {
    const p = refreshTransactions(ITEM);

    // The refresh request itself resolves first; no check has run yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(syncTransactions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]! - 1);
    expect(syncTransactions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(syncTransactions).toHaveBeenCalledTimes(1);

    await runPoll(p);
  });

  it('reports a failed refresh request and never polls', async () => {
    transactionsRefresh.mockRejectedValue(new Error('RATE_LIMIT_EXCEEDED'));

    const result = await refreshTransactions(ITEM);

    expect(result.error).toBe('RATE_LIMIT_EXCEEDED');
    expect(result.checks).toBe(0);
    expect(syncTransactions).not.toHaveBeenCalled();
  });

  it('stops on a failing sync rather than retrying an item that is broken', async () => {
    vi.mocked(syncTransactions).mockRejectedValue(new Error('ITEM_LOGIN_REQUIRED'));

    const result = await runPoll(refreshTransactions(ITEM));

    expect(syncTransactions).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('ITEM_LOGIN_REQUIRED');
    expect(result.checks).toBe(1);
  });

  it('reports an unknown item without calling Plaid', async () => {
    const result = await refreshTransactions('item-missing');

    expect(result.error).toContain('item-missing');
    expect(transactionsRefresh).not.toHaveBeenCalled();
  });

  it('aborting mid-wait cancels without running another check', async () => {
    const controller = new AbortController();
    const p = refreshTransactions(ITEM, { signal: controller.signal });

    // Land one check, then abort during the wait before the second.
    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0]!);
    expect(syncTransactions).toHaveBeenCalledTimes(1);

    controller.abort();
    const result = await runPoll(p);

    expect(result.cancelled).toBe(true);
    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });

  it('reports progress for the request, each wait, and each check', async () => {
    const steps: RefreshProgress[] = [];
    await runPoll(refreshTransactions(ITEM, { onProgress: (p) => steps.push(p) }));

    expect(steps[0]).toEqual({ phase: 'requesting' });
    expect(steps.filter((s) => s.phase === 'waiting')).toHaveLength(POLL_DELAYS_MS.length);
    expect(steps.filter((s) => s.phase === 'checking')).toHaveLength(POLL_DELAYS_MS.length);
  });

  it('passes each sync step through so the caller can render it', async () => {
    vi.mocked(syncTransactions).mockImplementation(async (_token, _id, onProgress) => {
      onProgress?.({ phase: 'transactions', page: 1, fetched: 1200 });
      return nothing;
    });

    const steps: RefreshProgress[] = [];
    await runPoll(refreshTransactions(ITEM, { onProgress: (p) => steps.push(p) }));

    const syncStep = steps.find((s) => s.phase === 'sync');
    expect(syncStep).toBeDefined();
    expect(describeRefreshProgress(syncStep!)).toContain('1,200 so far');
  });

  describe('syncResults (feeds the ⚠ badge)', () => {
    it('carries a failed check so the badge can be raised', async () => {
      vi.mocked(syncTransactions).mockRejectedValue(new Error('ITEM_LOGIN_REQUIRED'));

      const result = await runPoll(refreshTransactions(ITEM));

      expect(result.syncResults).toEqual([
        { itemId: ITEM, added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: 'ITEM_LOGIN_REQUIRED' },
      ]);
    });

    it('carries a clean check so a stale badge can be cleared', async () => {
      vi.mocked(syncTransactions).mockResolvedValueOnce({ added: 1, modified: 0, removed: 0, dupes: 0 });

      const result = await runPoll(refreshTransactions(ITEM));

      expect(result.syncResults).toEqual([
        { itemId: ITEM, added: 1, modified: 0, removed: 0, dupes: 0, skipped: false },
      ]);
    });

    it('stays empty when the refresh request failed, so no badge is touched', async () => {
      transactionsRefresh.mockRejectedValue(new Error('RATE_LIMIT_EXCEEDED'));

      const result = await refreshTransactions(ITEM);

      expect(result.syncResults).toEqual([]);
    });
  });
});

describe('describeRefreshProgress', () => {
  it('counts down as the deadline approaches rather than repeating the delay', () => {
    const step: RefreshProgress = { phase: 'waiting', attempt: 1, attempts: 4, until: Date.now() + 60_000 };
    expect(describeRefreshProgress(step)).toContain('next check in 60s');

    vi.advanceTimersByTime(45_000);
    expect(describeRefreshProgress(step)).toContain('next check in 15s');
  });

  it('says the refresh was requested, never that it completed', () => {
    const step: RefreshProgress = { phase: 'waiting', attempt: 1, attempts: 4, until: Date.now() + 15_000 };
    const text = describeRefreshProgress(step);
    expect(text).toContain('Refresh requested');
    expect(text.toLowerCase()).not.toContain('complete');
  });
});

describe('describeRefreshResult', () => {
  const base = { itemId: ITEM, added: 0, modified: 0, removed: 0, checks: 4, cancelled: false, syncResults: [] };

  it('does not claim the refresh finished when nothing turned up', () => {
    const text = describeRefreshResult(base);
    expect(text).toContain('may still be running');
    expect(text.toLowerCase()).not.toContain('complete');
  });

  it('reports what landed', () => {
    expect(describeRefreshResult({ ...base, added: 1 })).toBe('Done — 1 new transaction');
    expect(describeRefreshResult({ ...base, added: 2, modified: 1 })).toBe('Done — 2 new transactions, 1 updated');
  });

  it('distinguishes a cancelled poll from an exhausted one', () => {
    expect(describeRefreshResult({ ...base, cancelled: true })).toContain('Stopped checking');
    expect(describeRefreshResult({ ...base, cancelled: true, added: 2 })).toBe('Stopped checking — found 2 new transactions');
  });
});
