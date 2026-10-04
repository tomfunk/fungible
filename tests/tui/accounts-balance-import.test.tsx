import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../../core/db.js';
import { Accounts } from '../../tui/Accounts.js';
import { RefreshProvider } from '../../tui/RefreshContext.js';
import { TypingContext } from '../../tui/TypingContext.js';
import { waitFor, flatFrame as flat, pressAndWait } from '../helpers/waitFor.js';
import { useTempCsv } from '../helpers/tempCsv.js';

const { csv, dir } = useTempCsv('bh-import-');

function renderAccounts() {
  return render(
    <RefreshProvider>
      <TypingContext.Provider value={() => {}}>
        <Accounts onNavigate={() => {}} showHints={false} />
      </TypingContext.Provider>
    </RefreshProvider>,
  );
}

async function toBhFile(r: ReturnType<typeof render>) {
  await pressAndWait(r, '\t', 'Links');
  await pressAndWait(r, '\t', '[b] Import balance history');
  await pressAndWait(r, 'b', 'amount owed as a positive number');
}

async function typePath(r: ReturnType<typeof render>, path: string) {
  r.stdin.write(path); // one chunk: no coalescing concern, and far faster than per-key presses
  await new Promise((res) => setTimeout(res, 15));
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
    await pressAndWait(r, 'x', '[b] Import balance history');
  });

  it('maps an unmatched name to an account with [m]', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Old Bank,300\n'));
    await waitFor(() => expect(flat(r)).toContain('no matching account'));
    expect(flat(r)).toContain('Old Bank (1 row)');
    expect(flat(r)).toContain('0 balances will be added');
    expect(flat(r)).toContain('No valid rows');
    await pressAndWait(r, 'm', 'Map "Old Bank"');
    await pressAndWait(r, '\u001b[B', '› Checking');
    await pressAndWait(r, '\r', '1 balances will be added');
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
    await waitFor(() => expect(flat(r)).toContain('Press Enter to preview'));
    expect(flat(r)).toMatch(/header|column|date/i); // core error shown
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
    // Enter is a no-op with zero valid rows; the preview stays up and nothing is written.
    await waitFor(() => expect(flat(r)).toContain('No valid rows'));
    expect(flat(r)).toContain('preview');
    expect(await total()).toBe(1);
  });

  it('writes nothing when cancelled at the preview', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n'));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    await pressAndWait(r, '\u001b', '[b] Import balance history');
    expect(await total()).toBe(1);
  });

  it('shows an error and stays on the file step for a missing file', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, join(dir, 'does-not-exist.csv'));
    await waitFor(() => expect(flat(r)).toContain('File not found'));
    expect(flat(r)).toContain('Press Enter to preview');
  });

  it('shows the import entry and subtitle on the Add Data landing', async () => {
    const r = renderAccounts();
    await pressAndWait(r, '\t', 'Links');
    await pressAndWait(r, '\t', '[b] Import balance history');
    expect(flat(r)).toContain('Past balances from a date,account,balance file');
  });

  it('merges invalid date/amount reasons and lists mixed skip reasons in the count line', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv(
      'date,account,balance\n2026-01-01,Checking,100\n2026-01-02,Nowhere,5\n2026-01-03,Elsewhere,6\nnope,Checking,7\n2026-01-04,Checking,abc\n',
    ));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added, 0 will replace existing values, 4 skipped'));
    expect(flat(r)).toContain('(2 no matching account, 2 invalid date or amount)');
    expect(await total()).toBe(1);
  });

  it('maps an ambiguous name to one chosen account; Skip default imports nothing', async () => {
    await db.execute({ sql: "INSERT INTO accounts (id, name, type) VALUES ('s1', 'Shared', 'depository'), ('s2', 'Shared', 'depository')", args: [] });
    await db.execute({ sql: "INSERT INTO balance_history (account_id, balance, date) VALUES ('s1', 10, '2026-05-20'), ('s2', 20, '2026-05-20')", args: [] });
    const before = await total();

    // Skip default: accept without choosing
    let r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Shared,300\n'));
    await waitFor(() => expect(flat(r)).toContain('ambiguous'));
    expect(flat(r)).toContain('1 ambiguous account name');
    expect(flat(r)).toContain('0 balances will be added');
    await pressAndWait(r, 'm', 'Map "Shared"');
    await pressAndWait(r, '\r', '1 skipped by you'); // Skip these rows
    expect(flat(r)).toContain('0 balances will be added');
    expect(flat(r)).toContain('No valid rows');
    expect(await total()).toBe(before);
    cleanup();

    // Pick one of the two
    r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Shared,300\n'));
    await waitFor(() => expect(flat(r)).toContain('ambiguous'));
    await pressAndWait(r, 'm', 'Map "Shared"');
    await pressAndWait(r, '\u001b[B', '› Checking');
    await pressAndWait(r, '\u001b[B', '› Shared'); // one of the two same-named accounts
    await pressAndWait(r, '\r', '1 balances will be added');
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Added 1, replaced 0'));
    expect(await total()).toBe(before + 1);
    // Exactly one of the two same-named accounts got the row (order-independent).
    const lens = [(await history('s1')).length, (await history('s2')).length].sort();
    expect(lens).toEqual([1, 2]);
    expect(await history('chk')).toEqual([['2026-05-20', 5000]]);
  });

  it('skips rows not older than the current balance and does not write them', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n2026-05-20,Checking,1\n2026-06-01,Checking,2\n'));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    expect(flat(r)).toContain('2 skipped (2 newer than the current balance)');
    expect(flat(r)).toContain('line 3: newer than the current balance');
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Added 1, replaced 0, skipped 2'));
    expect(await history('chk')).toEqual([['2026-01-01', 100], ['2026-05-20', 5000]]);
  });

  it('caps the skipped list at 5 with a "+N more" line', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `bad${i},Checking,abc`).join('\n');
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv(`date,account,balance\n${rows}\n`));
    await waitFor(() => expect(flat(r)).toContain('8 skipped (8 invalid date or amount)'));
    expect(flat(r)).toContain('line 6: invalid date or amount');
    expect(flat(r)).not.toContain('line 7:');
    expect(flat(r)).toContain('+3 more');
  });

  it('accepts a relative path', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    // Pin cwd to the temp dir so the typed path is short and independent of where vitest was launched.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      csv('date,account,balance\n2026-01-01,Checking,100\n', 'rel.csv');
      await typePath(r, 'rel.csv');
      await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
      r.stdin.write('\r');
      await waitFor(() => expect(flat(r)).toContain('Added 1'));
      expect(await history('chk')).toEqual([['2026-01-01', 100], ['2026-05-20', 5000]]);
    } finally { cwd.mockRestore(); }
  });

  it('expands a leading ~ to the home directory', async () => {
    const prev = process.env.HOME;
    process.env.HOME = dir;
    try {
      writeFileSync(join(dir, 'home.csv'), 'date,account,balance\n2026-01-01,Checking,100\n');
      const r = renderAccounts();
      await toBhFile(r);
      await typePath(r, '~/home.csv');
      await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    } finally { process.env.HOME = prev; }
  });

  it('reads a .txt file the same as a .csv', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n', 'history.txt'));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
  });

  it('rejects an oversize file before reading it and stays on the file step', async () => {
    const big = 'date,account,balance\n' + '2026-01-01,Checking,1\n'.repeat(Math.ceil((5 * 1024 * 1024) / 22) + 10);
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv(big, 'big.csv'));
    await waitFor(() => expect(flat(r)).toContain('larger than 5 MB, the limit for a balance history import'));
    expect(flat(r)).toContain('Press Enter to preview');
    expect(flat(r)).not.toContain('will be added');
    expect(await total()).toBe(1);
  });

  it('lists rows mapped to Skip as "skipped by you" without treating them as an error', async () => {
    const r = renderAccounts();
    await toBhFile(r);
    await typePath(r, csv('date,account,balance\n2026-01-01,Checking,100\n2026-01-02,Old Bank,5\n'));
    await waitFor(() => expect(flat(r)).toContain('1 balances will be added'));
    await pressAndWait(r, 'm', 'Map "Old Bank"');
    await pressAndWait(r, '\r', '(1 skipped by you)');
    expect(flat(r)).toContain('line 3: skipped by you');
    expect(flat(r)).toContain('1 balances will be added');
    expect(flat(r)).not.toContain('Old Bank (1 row)');
    expect(flat(r)).not.toContain('No valid rows');
    r.stdin.write('\r');
    await waitFor(() => expect(flat(r)).toContain('Added 1, replaced 0, skipped 1'));
  });
});
