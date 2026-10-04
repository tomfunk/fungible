import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// tui/Accounts.tsx is the only TUI screen that spawns anything (scripts/link.ts),
// so stubbing spawn lets the link panel be driven without a real subprocess.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

// Keep householdMembers real (a pure helper used by the owner picker) but stub
// the DB-backed loadProfile/saveProfile. loadProfile is a vi.fn so a test can
// supply a profile whose members populate the cycle.
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { extractLinkUrl } from '../../tui/Accounts.js';
import * as syncApi from '../../core/sync.js';
import { waitFor, flatFrame } from '../helpers/waitFor.js';
import { fakeLinkProcess, useSeededScreenDb } from './helpers/screenSetup.js';
import { renderAccounts, tabTo } from './helpers/accountsScreen.js';

useSeededScreenDb();

describe('Accounts', () => {
  afterEach(() => vi.restoreAllMocks());

  // The link URL is printed once by scripts/link.ts and then buried by later
  // status lines ("Waiting for you to connect…"), which share the single
  // linkMsg slot. It has to be captured from the chunk and pinned separately —
  // on Linux there is no `open`, so it is the only way into the Plaid flow.
  describe('link URL capture', () => {
    it('pins an https origin when an OAuth redirect is configured', () => {
      expect(extractLinkUrl('Opening https://localhost:4747 …')).toBe('https://localhost:4747');
    });

    it('extracts the URL from the line link.ts prints', () => {
      expect(extractLinkUrl('Opening http://localhost:4747 …')).toBe('http://localhost:4747');
    });

    it('finds the URL anywhere in a multi-line chunk, not just the last line', () => {
      const chunk = 'Opening http://localhost:4747 …\nWaiting for you to connect in the browser…\n';
      // The last line is what becomes linkMsg, so a last-line-only scan would miss it.
      expect(chunk.trim().split('\n').pop()).not.toContain('localhost');
      expect(extractLinkUrl(chunk)).toBe('http://localhost:4747');
    });

    it('returns null for status lines that carry no URL', () => {
      expect(extractLinkUrl('Saving institution…')).toBeNull();
      expect(extractLinkUrl('Creating Plaid link token…')).toBeNull();
    });

    it('reads whatever port link.ts is using rather than assuming one', () => {
      expect(extractLinkUrl('Opening http://localhost:8080 …')).toBe('http://localhost:8080');
    });

    // The regression the user hit: the URL scrolled away behind the next status
    // line, leaving nothing to click while the ticker counted up.
    it('keeps the URL on screen after later status lines replace the message', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');                                   // → history-window prompt
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');                                  // → starts the link
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.stdout.emit('data', Buffer.from('Opening http://localhost:4747 …\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('http://localhost:4747'));

      // This line takes over linkMsg — the URL must survive it.
      proc.stdout.emit('data', Buffer.from('Waiting for you to connect in the browser…\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('Waiting for you to connect'));
      expect(flatFrame(r)).toContain('http://localhost:4747');

      // Still there several status lines later.
      proc.stdout.emit('data', Buffer.from('Account link received from Chase — exchanging token…\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('exchanging token'));
      expect(flatFrame(r)).toContain('http://localhost:4747');
    });

    // Same defect shape: the generic exit-code line used to bury the stderr
    // reason, so a crash reported only that it happened, never why.
    it('keeps the stderr reason instead of replacing it with the exit code', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.stderr.emit('data', Buffer.from('Error: listen EADDRINUSE: address already in use 127.0.0.1:4747\n'));
      await waitFor(() => expect(flatFrame(r)).toContain('EADDRINUSE'));
      proc.emit('close', 1);

      await waitFor(() => expect(flatFrame(r)).toContain('Press Enter to return.'));
      expect(flatFrame(r)).toContain('EADDRINUSE');
      expect(flatFrame(r)).not.toContain('Process exited with code 1');
    });

    // The post-link sync runs while the link panel is still on screen. It used
    // to render only linkMsg, so every sync step was invisible and the elapsed
    // counter sat next to the finished link message — indistinguishable from a
    // link that had stalled.
    it('shows sync progress on the link panel after the link completes', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);
      vi.spyOn(syncApi, 'syncAll').mockImplementation(async (_f, _ids, onProgress) => {
        onProgress?.('item-x', { phase: 'transactions', page: 1, fetched: 4321 });
        return new Promise(() => []) as never;
      });
      // A placeholder row, so the close handler finds an item to sync.
      await db.execute({
        sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)',
        args: ['item-x', 'tok', 'Progress Bank'],
      });

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.emit('close', 0);
      await waitFor(() => expect(flatFrame(r)).toContain('Bank connected!'));
      // Still on the link panel — the sync step must be visible from here.
      await waitFor(() => expect(flatFrame(r)).toContain('Fetching transactions… 4,321 so far'));
    });

    it('still reports a bare exit code when the child said nothing on stderr', async () => {
      const proc = fakeLinkProcess();
      vi.mocked(spawn).mockReturnValue(proc as never);

      const r = renderAccounts();
      await waitFor(() => expect(flatFrame(r)).toContain('Test Checking'));
      await tabTo(r, 'add-data');
      r.stdin.write('l');
      await waitFor(() => expect(flatFrame(r)).toContain('days'));
      r.stdin.write('\r');
      await waitFor(() => expect(flatFrame(r)).toContain('Link Bank Account'));

      proc.emit('close', 1);
      await waitFor(() => expect(flatFrame(r)).toContain('Process exited with code 1'));
    });
  });
});
