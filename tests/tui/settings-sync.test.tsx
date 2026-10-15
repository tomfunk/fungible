import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

// The network edge: connect/disconnect and the sync cycle are stubbed; the
// screen's own behavior (mode display, confirmation path, counts) is under test.
const h = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  cycle: vi.fn(),
}));
vi.mock('../../core/sync-mode.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/sync-mode.js')>();
  return { ...actual, connectAccount: h.connect, disconnectAccount: h.disconnect };
});
vi.mock('../../core/sync-client.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/sync-client.js')>();
  return { ...actual, runSyncCycle: h.cycle, startBackgroundSync: vi.fn(), stopBackgroundSync: vi.fn() };
});

import { Settings } from '../../tui/Settings.js';
import { configureAuth, memoryAuthAdapter } from '../../core/auth-client.js';
import { SyncError } from '../../core/sync-mode.js';
import { MigrateError } from '../../core/migrate.js';
import { waitFor as baseWaitFor, frame } from '../helpers/waitFor.js';
import { W, noop, useSeededScreenDb } from './helpers/screenSetup.js';

// Generous headroom for slow CI / coverage runs, as in settings.test.tsx.
const waitFor: typeof baseWaitFor = (assertion, opts = 10_000) => baseWaitFor(assertion, opts);

vi.setConfig({ testTimeout: 30_000 });
useSeededScreenDb();

const DOWN = '\x1B[B';
// With no spouse/children the rows are: name, year, add-spouse, add-child, theme, toggle,
// then sync-email(6), sync-password(7), sync-login(8), sync-register(9).
async function down(r: ReturnType<typeof render>, n: number) {
  for (let i = 0; i < n; i++) { r.stdin.write(DOWN); await new Promise((res) => setTimeout(res, 15)); }
}

async function typeInto(r: ReturnType<typeof render>, text: string, shown = text) {
  r.stdin.write('\r');
  await waitFor(() => expect(frame(r)).toContain('▊'));
  r.stdin.write(text);
  await waitFor(() => expect(frame(r)).toContain(shown));
  r.stdin.write('\r');
  await waitFor(() => expect(frame(r)).not.toContain('▊'));
}

function settings() {
  return render(<W><Settings onNavigate={noop} showHints={false} /></W>);
}

const STATS = { pushed: 3, adopted: 0, pullApplied: 2, pullSkipped: 0, superseded: 0, conflictsRebased: 0, errors: [], conflicts: [] };

describe('Settings sync section (FUNGIBLE_SYNC_URL set)', () => {
  beforeEach(() => {
    configureAuth(memoryAuthAdapter(), 'https://sync.test');
    h.connect.mockReset().mockResolvedValue(undefined);
    h.disconnect.mockReset().mockResolvedValue(undefined);
    h.cycle.mockReset().mockResolvedValue({ ...STATS });
  });

  async function fillCredentials(r: ReturnType<typeof render>) {
    await waitFor(() => expect(frame(r)).toContain('Local (BYOK)'));
    await down(r, 6);
    await typeInto(r, 'me@example.com');
    await down(r, 1);
    await typeInto(r, 'hunter2', '•'.repeat(7)); // password is masked
  }

  it('shows Local (BYOK) and connect controls by default', async () => {
    const r = settings();
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('SYNC');
      expect(f).toContain('Local (BYOK)');
      expect(f).toContain('Connect (log in)');
    });
  });

  it('connect shows the account and the sync result', async () => {
    h.cycle.mockResolvedValue({ ...STATS, superseded: 2, conflictsRebased: 2 });
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);                 // sync-login
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Synced via account: me@example.com');
      expect(f).toContain('2 pulled, 3 pushed, 2 superseded');
    });
    expect(h.connect).toHaveBeenCalledTimes(1);
    const [email, pw, opts] = h.connect.mock.calls[0];
    expect([email, pw]).toEqual(['me@example.com', 'hunter2']);
    expect(opts).toMatchObject({ createAccount: false, resetForNewAccount: false });
    expect(opts).not.toHaveProperty('beforeMigrate');
  });

  it('account_mismatch asks for confirmation, then retries with resetForNewAccount', async () => {
    h.connect.mockRejectedValueOnce(new SyncError('account_mismatch'));
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('different account');
      expect(f).toContain('Reset local sync state for this account');
    });
    expect(frame(r)).not.toContain('Synced via account');
    expect(h.connect).toHaveBeenCalledTimes(1);

    // Cursor moves onto the confirmation row (sync-reset) once the prompt renders.
    await waitFor(() => expect(frame(r)).toContain('▶ [Enter] Reset'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Synced via account'));
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connect.mock.calls[1][2]).toMatchObject({ resetForNewAccount: true });
  });

  it('cancelling the mismatch confirmation connects nothing', async () => {
    h.connect.mockRejectedValueOnce(new SyncError('account_mismatch'));
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('▶ [Enter] Reset'));
    await down(r, 1);                 // sync-cancel
    await waitFor(() => expect(frame(r)).toContain('▶ [Enter] Cancel'));
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Connect (log in)'));
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(frame(r)).toContain('Local (BYOK)');
  });

  it('a failed safety snapshot is reported and nothing is enabled', async () => {
    h.connect.mockRejectedValueOnce(new MigrateError('snapshot_failed', 'disk full'));
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Could not take a safety backup; sync was not enabled'));
    expect(frame(r)).toContain('disk full');
    expect(frame(r)).toContain('Local (BYOK)');
  });

  it('other connect errors are shown and leave the install in BYOK', async () => {
    h.connect.mockRejectedValueOnce(new Error('invalid_credentials'));
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Error: invalid_credentials'));
    expect(frame(r)).toContain('Local (BYOK)');
  });

  it('disconnect returns to Local (BYOK) and keeps data', async () => {
    const r = settings();
    await fillCredentials(r);
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => expect(frame(r)).toContain('Synced via account'));
    // Rows now: ..., toggle(5), sync-now(6), sync-logout(7); cursor stayed at 8 -> clamped to last.
    await waitFor(() => expect(frame(r)).toContain('Disconnect (data stays local)'));
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Local (BYOK)');
      expect(f).toContain('Disconnected. Local data stays on this machine.');
    });
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('Settings sync status lines (connected)', () => {
  it('shows pending, held, rejected and a clock-skew warning', async () => {
    configureAuth(memoryAuthAdapter(), 'https://sync.test');
    h.connect.mockReset().mockResolvedValue(undefined);
    h.cycle.mockReset().mockResolvedValue({
      pushed: 1, adopted: 0, pullApplied: 0, pullSkipped: 0, superseded: 0, conflictsRebased: 0,
      errors: [], conflicts: [], clockSkew: true,
    });
    const r = settings();
    await waitFor(() => expect(frame(r)).toContain('Local (BYOK)'));
    await down(r, 6);
    await typeInto(r, 'me@example.com');
    await down(r, 1);
    await typeInto(r, 'hunter2', '•'.repeat(7));
    await down(r, 1);
    r.stdin.write('\r');
    await waitFor(() => {
      const f = frame(r);
      expect(f).toContain('Synced via account');
      expect(f).toContain('clock looks wrong');
      expect(f).toContain('0 pending');
    });
    expect(frame(r)).not.toContain('waiting for the server to catch up');
  });
});
