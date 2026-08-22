import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render, cleanup } from 'ink-testing-library';

// Setup lives in its own test file (rather than screens.test.tsx) because it
// needs two process-level fakes that would leak into every other screen: a
// DATA_DIR holding a pre-filled .env, and a stubbed child_process.spawn.
// Async so the temp dir exists before the core/paths mock below is consumed —
// vi.hoisted runs ahead of this file's imports, so it loads node builtins itself.
const { DATA_DIR } = await vi.hoisted(async () => {
  const [fsMod, osMod, pathMod] = await Promise.all([
    import('node:fs'), import('node:os'), import('node:path'),
  ]);
  const dir = fsMod.default.mkdtempSync(pathMod.default.join(osMod.default.tmpdir(), 'fungible-setup-'));
  fsMod.default.writeFileSync(
    pathMod.default.join(dir, '.env'),
    'PLAID_CLIENT_ID=cid\nPLAID_SECRET=sec\nPLAID_ENV=sandbox\n',
  );
  return { DATA_DIR: dir };
});

vi.mock('../../core/paths.js', () => ({ DATA_DIR }));

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

const spawnMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
})));

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { db } from '../../core/db.js';
import { Setup } from '../../tui/Setup.js';
import { daysFromStartDate, MAX_DAYS_REQUESTED } from '../../core/settings.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const frame = (r: ReturnType<typeof render>) => (r.lastFrame() ?? '').replace(ANSI_RE, '');

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

/** YYYY-MM-DD for a date `n` days before today, in local time. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const spawnEnv = () => (spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;

beforeEach(() => db.execute('DELETE FROM settings')); // each test starts with no saved start date
afterEach(() => { cleanup(); spawnMock.mockClear(); });
afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

// The wizard saves a default start date and then offers to link the first bank.
// days_requested is locked when Plaid creates the Item, so if the start date
// doesn't reach scripts/link.ts on that first link it can never be widened —
// the link script omits days_requested and Plaid silently backfills 90 days.
describe('Setup wizard link step', () => {
  it('passes the days derived from the saved start date to the link script', async () => {
    const startDate = daysAgo(200);
    const r = render(<Setup />);

    await waitFor(() => expect(frame(r)).toContain('Welcome to fungible'));
    r.stdin.write('\r');                            // welcome → start-date (creds already in .env)
    await waitFor(() => expect(frame(r)).toContain('Default history start date'));
    r.stdin.write(startDate);
    await waitFor(() => expect(frame(r)).toContain(startDate));
    r.stdin.write('\r');                            // save → link-choice
    await waitFor(() => expect(frame(r)).toContain('Link a bank account'));
    r.stdin.write('y');                             // link now

    await waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(spawnEnv()?.PLAID_DAYS_REQUESTED).toBe(String(daysFromStartDate(startDate))),
    );
    expect(spawnEnv()?.PLAID_DAYS_REQUESTED).toBe('202'); // 200 days + the 2-day buffer
  });

  it('falls back to the maximum window when the start date is skipped', async () => {
    const r = render(<Setup />);

    await waitFor(() => expect(frame(r)).toContain('Welcome to fungible'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Default history start date'));
    r.stdin.write('\r');                            // blank → skip to link-choice
    await waitFor(() => expect(frame(r)).toContain('Link a bank account'));
    r.stdin.write('y');

    await waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(spawnEnv()?.PLAID_DAYS_REQUESTED).toBe(String(MAX_DAYS_REQUESTED)),
    );
  });
});
