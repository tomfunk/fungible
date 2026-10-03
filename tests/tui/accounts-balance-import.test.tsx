import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { Accounts } from '../../tui/Accounts.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;
const flat = (r: ReturnType<typeof render>) =>
  (r.lastFrame() ?? '').replace(ANSI_RE, '').replace(/\s+/g, ' ');

async function waitFor(assertion: () => void, timeout = 1500): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 30));
  }
  throw lastErr;
}

const dir = mkdtempSync(join(tmpdir(), 'bh-import-'));
let n = 0;
function csv(text: string): string {
  const p = join(dir, `f${n++}.csv`);
  writeFileSync(p, text);
  return p;
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

async function press(r: ReturnType<typeof render>, key: string) {
  r.stdin.write(key);
  await new Promise((res) => setTimeout(res, 40));
}

async function toBhFile(r: ReturnType<typeof render>) {
  await press(r, '\t');
  await waitFor(() => expect(flat(r)).toContain('Links'));
  await press(r, '\t');
  await waitFor(() => expect(flat(r)).toContain('[b] Import balance history'));
  await press(r, 'b');
  await waitFor(() => expect(flat(r)).toContain('amount owed as a positive number'));
}

async function typePath(r: ReturnType<typeof render>, path: string) {
  for (const ch of path) r.stdin.write(ch);
  await waitFor(() => expect(flat(r)).toContain(path.slice(-12)));
  r.stdin.write('\r');
}

async function history(id: string) {
  const res = await db.execute({ sql: 'SELECT date, balance FROM balance_history WHERE account_id = ? ORDER BY date', args: [id] });
  return res.rows.map((x) => [x.date, Number(x.balance)]);
}
const total = async () => Number((await db.execute('SELECT COUNT(*) c FROM balance_history')).rows[0].c);

beforeEach(async () => {
  await db.execute('DELETE FROM balance_history');
  await db.execute('DELETE FROM accounts');
  await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES ('chk', 'Checking', 'depository')", args: [] });
  await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('chk', 5000, '2026-05-20')", args: [] });
});

afterEach(() => cleanup());

describe('TUI Accounts — balance history import', () => {
  it('previews then commits a valid file', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n2026-02-01,Checking,200\n'));
    await waitFor(() => expect(flat(r)).toContain('2 balances will be added, 0 will replace existing values, 0 skipped'));
    expect(await total()).toBe(1); // nothing written at preview
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Net worth history updated. Added 2, replaced 0, skipped 0.'));
    expect(await history('chk')).toEqual([['2026-01-01', 100], ['2026-02-01', 200], ['2026-05-20', 5000]]);
    await press(r, 'x');
    await waitFor(() => expect(flat(r)).toContain('[b] Import balance history'));
  });

  it('maps an unmatched name to an account with [m]', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Old Bank,300\n'));
    await waitFor(() => expect(flat(r)).toContain('no matching account'));
    expect(flat(r)).toContain('Old Bank (1 row)');
    expect(flat(r)).toContain('0 balances will be added');
    expect(flat(r)).toContain('No valid rows');
    await press(r, 'm');
    await waitFor(() => expect(flat(r)).toContain('Map "Old Bank"'));
    await press(r, '\u001b[B');
    await press(r, '\r');
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Added 1, replaced 0'));
    expect(await history('chk')).toContainEqual(['2026-01-01', 300]);
  });

  it('shows the overwrite count and replaces the stored value', async () => {
    await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('chk', 111, '2026-01-01')", args: [] });
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,999\n'));
    await waitFor(() => expect(flat(r)).toContain('0 balances will be added, 1 will replace existing values'));
    expect(flat(r)).toMatch(/2026-01-01: \d+\.\d{2} → 999\.00/);
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Added 0, replaced 1'));
    expect(await history('chk')).toContainEqual(['2026-01-01', 999]);
  });

  it('commits nothing for a bad header', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('foo,bar\n1,2\n'));
    await new Promise((res) => setTimeout(res, 150));
    expect(flat(r)).toContain('amount owed as a positive number'); // still on bh-file
    expect(flat(r)).not.toContain('will be added');
    expect(await total()).toBe(1);
  });

  it('commits nothing when every row is invalid', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\nnope,Checking,abc\n2026-03-01,Checking,xyz\n'));
    await waitFor(() => expect(flat(r)).toContain('2 skipped (2 invalid date or amount)'));
    expect(flat(r)).toContain('line 2: invalid date or amount');
    expect(flat(r)).toContain('No valid rows');
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 150));
    expect(flat(r)).toContain('preview');
    expect(await total()).toBe(1);
  });

  it('writes nothing when cancelled at the preview', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n'));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    await press(r, '\u001b');
    await waitFor(() => expect(flat(r)).toContain('[b] Import balance history'));
    expect(await total()).toBe(1);
  });

  it('shows an error and stays on the file step for a missing file', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, join(dir, 'does-not-exist.csv'));
    await waitFor(() => expect(flat(r)).toContain('File not found'));
    expect(flat(r)).toContain('Press Enter to preview');
  });
});
