import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render, cleanup } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// The link flow runs in a spawned child. Stand in for it so a test can drive the
// exit code directly instead of launching Plaid.
const spawned: { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild();
    spawned.push({ args, env: opts.env, child });
    return child;
  },
}));

vi.mock('../../core/sync.js', () => ({ syncAll: vi.fn().mockResolvedValue([]) }));

import { db } from '../../core/db.js';
import { syncAll } from '../../core/sync.js';
import { Accounts } from '../../tui/Accounts.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const flat = (r: ReturnType<typeof render>) =>
  (r.lastFrame() ?? '').replace(ANSI_RE, '').replace(/\s+/g, ' ');

async function waitFor(assertion: () => void, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

function renderAccounts() {
  return render(
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        <Accounts onNavigate={() => {}} showHints={false} />
      </TypingContext.Provider>
    </RefreshProvider>,
  );
}

/** Tab from the Accounts view to the Links view and wait for it to render. */
async function toLinks(r: ReturnType<typeof render>) {
  r.stdin.write('\t');
  await waitFor(() => expect(flat(r)).toContain('connection'));
}

/** Finish the most recently spawned link process with the given exit code. */
function finishLink(code: number) {
  spawned.at(-1)!.child.emit('close', code);
}

beforeEach(async () => {
  spawned.length = 0;
  vi.mocked(syncAll).mockClear();
  for (const t of ['transactions', 'balance_history', 'accounts', 'plaid_items', 'sync_state']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute(
    `INSERT INTO plaid_items (item_id, access_token, institution_name, last_synced_at) VALUES ('item-1', 'enc(tok)', 'Chase', 1750000000000)`,
  );
  await db.execute(
    `INSERT INTO accounts (id, name, type, subtype, item_id) VALUES ('acct-1', 'Chase Checking', 'depository', 'checking', 'item-1')`,
  );
});

afterEach(() => cleanup());

describe('Accounts — update link', () => {
  it('offers update link on a connection row', async () => {
    const r = renderAccounts();
    await toLinks(r);
    expect(flat(r)).toContain('[u] update link');
    expect(flat(r)).toContain('update creds for link, keeping its accounts and transactions');
  });

  it('puts the item id in the child environment so Link runs in update mode', async () => {
    const r = renderAccounts();
    await toLinks(r);

    r.stdin.write('u');
    await waitFor(() => expect(spawned).toHaveLength(1));

    expect(spawned[0].env.PLAID_UPDATE_ITEM_ID).toBe('item-1');
  });

  // An update cannot change the history window — it is fixed when the item is
  // created — so the days prompt that the add flow shows must be skipped.
  it('skips the history-window prompt and goes straight to Plaid', async () => {
    const r = renderAccounts();
    await toLinks(r);

    r.stdin.write('u');
    await waitFor(() => expect(flat(r)).toContain('Update Link Credentials'));
    expect(flat(r)).not.toContain('Transaction History Window');
  });

  // Without this, the row keeps its ⚠ badge and the banner still reads "sync
  // failed" after an update that actually worked — the item's last recorded sync
  // is the failure that sent the user here in the first place.
  it('syncs just this item once the update succeeds', async () => {
    const r = renderAccounts();
    await toLinks(r);

    r.stdin.write('u');
    await waitFor(() => expect(spawned).toHaveLength(1));
    expect(syncAll).not.toHaveBeenCalled();

    finishLink(0);
    await waitFor(() => expect(syncAll).toHaveBeenCalled());
    // Scoped to the updated item, so other connections' failures are untouched.
    expect(vi.mocked(syncAll).mock.calls[0][1]).toEqual(['item-1']);
  });

  it('does not sync when the update fails', async () => {
    const r = renderAccounts();
    await toLinks(r);

    r.stdin.write('u');
    await waitFor(() => expect(spawned).toHaveLength(1));

    finishLink(1);
    await waitFor(() => expect(flat(r)).toContain('exited with code 1'));
    expect(syncAll).not.toHaveBeenCalled();
  });

  it('does nothing when there are no connections to update', async () => {
    await db.execute(`DELETE FROM accounts`);
    await db.execute(`DELETE FROM plaid_items`);
    const r = renderAccounts();
    r.stdin.write('\t');
    await waitFor(() => expect(flat(r)).toContain('No bank connections yet.'));

    r.stdin.write('u');
    await new Promise((res) => setTimeout(res, 100));
    expect(spawned).toHaveLength(0);
  });
});
