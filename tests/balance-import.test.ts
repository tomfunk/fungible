import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  previewBalanceImport, commitBalanceImport, parseBalanceCsv, parseBalanceAmount, isRealIsoDate,
  BALANCE_IMPORT_SKIP_COPY, BALANCE_IMPORT_SKIP_REASONS, summarizeSkips,
} from '../core/balance-import.js';
import { executeTool, WRITE_TOOLS, describeToolCallDetailed } from '../core/tools.js';
import { onRefresh } from '../core/refresh.js';

const TODAY = '2026-06-01';
const opts = { today: TODAY };

async function acct(id: string, name: string, type = 'depository', nickname: string | null = null, excluded = 0) {
  await db.execute({
    sql: 'INSERT INTO accounts (id, name, nickname, type, excluded) VALUES (?, ?, ?, ?, ?)',
    args: [id, name, nickname, type, excluded],
  });
}
async function bal(id: string, date: string, balance: number) {
  await db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)', args: [id, balance, date] });
}
async function history(id: string) {
  const r = await db.execute({ sql: 'SELECT date, balance FROM balance_history WHERE account_id = ? ORDER BY date', args: [id] });
  return r.rows.map((x) => [x.date, Number(x.balance)]);
}
async function count() {
  return Number((await db.execute('SELECT COUNT(*) c FROM balance_history')).rows[0].c);
}

beforeEach(async () => {
  await db.execute('DELETE FROM accounts');
  await db.execute('DELETE FROM balance_history');
  await acct('chk', 'Checking');
  await bal('chk', '2026-05-20', 5000);
});

describe('tokenizeCsv unterminated quote', () => {
  it('returns best-effort records instead of throwing (balance import relies on this)', async () => {
    const { tokenizeCsv } = await import('../core/balance-import.js');
    const recs = tokenizeCsv('date,account,balance\n2025-01-01,"Chase,100\n2025-01-02,Amex,5');
    expect(recs[0].fields).toEqual(['date', 'account', 'balance']);
    expect(recs).toHaveLength(2);
    expect(recs[1].fields[0]).toBe('2025-01-01');
  });
});

describe('parser edge cases', () => {
  it.each([
    ['BOM', '﻿date,account,balance\n2026-01-01,Checking,100\n'],
    ['CRLF', 'date,account,balance\r\n2026-01-01,Checking,100\r\n'],
    ['lone CR', 'date,account,balance\r2026-01-01,Checking,100\r'],
    ['no trailing newline', 'date,account,balance\n2026-01-01,Checking,100'],
    ['blank lines', '\n\ndate,account,balance\n\n2026-01-01,Checking,100\n\n'],
    ['reordered + extra columns, mixed case', 'Notes,BALANCE,Date,Account\nx,100,2026-01-01,Checking\n'],
    ['quoted comma name', 'date,account,balance\n2026-01-01,"Checking",100\n'],
    ['quoted amount with comma', 'date,account,balance\n2026-01-01,Checking,"1,000"\n'],
  ])('parses %s', async (_n, csv) => {
    const p = await previewBalanceImport(csv, opts);
    expect(p.totalRows).toBe(1);
    expect(p.valid).toBe(1);
    expect(p.skipped).toEqual([]);
  });

  it('handles quoted commas and escaped quotes in names', async () => {
    await acct('x', 'Smith, "Joint" Savings');
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,"Smith, ""Joint"" Savings",5\n', opts);
    expect(p.valid).toBe(1);
    expect(p.resolved[0].accountId).toBe('x');
  });

  it.each([
    ['2025-02-30', 'invalid_date'],
    ['2025-13-01', 'invalid_date'],
    ['1/15/2025', 'invalid_date'],
    ['01-15-2025', 'invalid_date'],
    ['2025-1-5', 'invalid_date'],
    ['Jan 5 2025', 'invalid_date'],
  ])('rejects date %s', async (d, reason) => {
    const p = await previewBalanceImport(`date,account,balance\n${d},Checking,1\n`, opts);
    expect(p.skipped[0].reason).toBe(reason);
    expect(p.valid).toBe(0);
  });

  it.each([
    ['$1,234.50', 1234.5], ['(50.00)', -50], ['-50', -50], ['0', 0], ['  12 ', 12], ['$ 5', 5], ['-$5', -5], ['.5', 0.5], ['(0)', 0],
  ])('parses amount %s', (raw, want) => {
    expect(parseBalanceAmount(raw)).toBe(want);
  });

  it.each(['abc', 'NaN', 'Infinity', '€50', '£5', '1.2.3', '', '--5', '5%', '(-5)', '-(5)'])('rejects amount %j', (raw) => {
    expect(parseBalanceAmount(raw)).toBeNull();
  });

  it('flags invalid amount and missing fields with 1-based line numbers', async () => {
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Checking,abc\n2026-01-02,Checking\n,Checking,5\n', opts);
    expect(p.skipped.map((s) => [s.line, s.reason])).toEqual([[2, 'invalid_amount'], [3, 'missing_field'], [4, 'missing_field']]);
  });

  it('throws on missing header, empty input and oversize', () => {
    expect(() => parseBalanceCsv('2026-01-01,Checking,100\n')).toThrow(/header/);
    expect(() => parseBalanceCsv('')).toThrow(/empty/);
    expect(() => parseBalanceCsv('date,account\n1,2\n')).toThrow(/balance/);
    expect(() => parseBalanceCsv('date,account,balance\n' + 'x'.repeat(5 * 1024 * 1024))).toThrow(/too large/);
    expect(() => parseBalanceCsv('date,account,balance\n' + 'a,b,c\n'.repeat(50_001))).toThrow(/too many/);
  });

  it('accepts exactly 50_000 rows and exactly 5MB', () => {
    expect(parseBalanceCsv('date,account,balance\n' + 'a,b,c\n'.repeat(50_000)).rows).toHaveLength(50_000);
    const head = 'date,account,balance\n';
    const exact = head + 'x'.repeat(5 * 1024 * 1024 - head.length);
    expect(Buffer.byteLength(exact)).toBe(5 * 1024 * 1024);
    expect(() => parseBalanceCsv(exact)).not.toThrow();
    expect(() => parseBalanceCsv(exact + 'x')).toThrow(/too large/);
  });

  it('parses a (-5) style amount as invalid', async () => {
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Checking,(-5)\n', opts);
    expect(p.skipped[0].reason).toBe('invalid_amount');
  });

  it('validates real calendar dates', () => {
    expect(isRealIsoDate('2024-02-29')).toBe(true);
    expect(isRealIsoDate('2025-02-29')).toBe(false);
  });
});

describe('preview and commit', () => {
  const csv = 'date,account,balance\n2026-01-01,Checking,100\n2026-02-01,Checking,200\n';

  it('preview makes zero writes', async () => {
    const before = await history('chk');
    const p = await previewBalanceImport(csv, opts);
    expect(p.willInsert).toBe(2);
    expect(await history('chk')).toEqual(before);
  });

  it('commit matches preview and is idempotent', async () => {
    const p = await previewBalanceImport(csv, opts);
    const r = await commitBalanceImport(csv, opts);
    expect(r).toEqual({ inserted: p.willInsert, overwritten: 0, skipped: 0, accountsTouched: 1 });
    expect(await history('chk')).toEqual([['2026-01-01', 100], ['2026-02-01', 200], ['2026-05-20', 5000]]);
    const again = await commitBalanceImport(csv, opts);
    expect(again).toMatchObject({ inserted: 0, overwritten: 2 });
    expect(await count()).toBe(3);
    const p2 = await previewBalanceImport(csv, opts);
    expect(p2.willOverwrite).toEqual({ count: 2, changed: 0 });
  });

  it('duplicate account/date: last row wins', async () => {
    const dup = 'date,account,balance\n2026-01-01,Checking,1\n2026-01-01,Checking,2\n';
    const p = await previewBalanceImport(dup, opts);
    expect(p.duplicatesInFile).toBe(1);
    expect(p.warnings.join(' ')).toMatch(/duplicate/);
    await commitBalanceImport(dup, opts);
    expect((await history('chk'))[0]).toEqual(['2026-01-01', 2]);
  });

  it('overwrites an existing synced row and reports changes', async () => {
    await bal('chk', '2026-03-01', 999);
    const c = 'date,account,balance\n2026-03-01,Checking,1000\n';
    const p = await previewBalanceImport(c, opts);
    expect(p.willOverwrite).toEqual({ count: 1, changed: 1 });
    expect(p.overwriteSample).toEqual([{ accountName: 'Checking', date: '2026-03-01', oldBalance: 999, newBalance: 1000 }]);
    const r = await commitBalanceImport(c, opts);
    expect(r).toMatchObject({ inserted: 0, overwritten: 1 });
    expect((await history('chk')).find((h) => h[0] === '2026-03-01')![1]).toBe(1000);
  });

  it('latest-snapshot guard and future dates', async () => {
    const c = 'date,account,balance\n2026-05-20,Checking,1\n2026-05-25,Checking,2\n2026-07-01,Checking,3\n2026-05-19,Checking,4\n';
    const p = await previewBalanceImport(c, opts);
    expect(p.skipped.map((s) => s.reason)).toEqual(['newer_than_current', 'newer_than_current', 'future_date']);
    expect(p.valid).toBe(1);
    await commitBalanceImport(c, opts);
    expect(await history('chk')).toEqual([['2026-05-19', 4], ['2026-05-20', 5000]]);
  });

  it('allows a row dated exactly today', async () => {
    await acct('sav', 'Savings');
    const p = await previewBalanceImport(`date,account,balance\n${TODAY},Savings,1\n`, opts);
    expect(p.valid).toBe(1);
    expect(p.skipped).toEqual([]);
  });

  describe('default today is the local date', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('uses local time near midnight', async () => {
      await acct('sav', 'Savings');
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 30)); // local
      const c = 'date,account,balance\n2026-06-15,Savings,1\n2026-06-16,Savings,2\n';
      let p = await previewBalanceImport(c);
      expect(p.valid).toBe(1);
      expect(p.skipped.map((s) => s.reason)).toEqual(['future_date']);
      vi.setSystemTime(new Date(2026, 5, 16, 0, 0, 30));
      p = await previewBalanceImport(c);
      expect(p.valid).toBe(2);
    });
  });

  it('allows every row for an account with no history', async () => {
    await acct('sav', 'Savings');
    const p = await previewBalanceImport('date,account,balance\n2026-05-31,Savings,1\n2026-05-01,Savings,2\n', opts);
    expect(p.valid).toBe(2);
  });

  it('matches by nickname, case-insensitively and trimmed', async () => {
    await acct('n', 'Acct 1234', 'depository', 'Rainy Day');
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,  rainy DAY ,5\n', opts);
    expect(p.resolved[0]).toMatchObject({ accountId: 'n', rows: 1, minDate: '2026-01-01', maxDate: '2026-01-01' });
  });

  it('accountMap overrides, skip-null, and unknown ids', async () => {
    await acct('sav', 'Savings');
    const c = 'date,account,balance\n2026-01-01,Old Bank,1\n2026-01-01,Junk,2\n2026-01-01,Ghost,3\n';
    const p = await previewBalanceImport(c, { ...opts, accountMap: { ' old BANK ': 'sav', junk: null, ghost: 'nope' } });
    expect(p.valid).toBe(1);
    expect(p.resolved[0]).toMatchObject({ csvName: 'Old Bank', accountId: 'sav' });
    expect(p.skipped.map((s) => s.reason)).toEqual(['user_skipped', 'no_matching_account']);
    expect(p.unmatched).toEqual([]);
  });

  it('ambiguous names need a map', async () => {
    await acct('a1', 'Visa');
    await acct('a2', 'Other', 'credit', 'visa');
    const c = 'date,account,balance\n2026-01-01,Visa,5\n';
    const p = await previewBalanceImport(c, opts);
    expect(p.skipped[0].reason).toBe('ambiguous_account');
    expect(p.ambiguous[0].candidates.map((x) => x.id).sort()).toEqual(['a1', 'a2']);
    const fixed = await previewBalanceImport(c, { ...opts, accountMap: { visa: 'a2' } });
    expect(fixed.valid).toBe(1);
  });

  it('unmatched names are reported with suggestions; matched rows still import', async () => {
    const c = 'date,account,balance\n2026-01-01,Checking,1\n2026-01-01,Checkin Account,2\n2026-01-02,Checkin Account,3\n';
    const p = await previewBalanceImport(c, opts);
    expect(p.unmatched).toHaveLength(1);
    expect(p.unmatched[0]).toMatchObject({ name: 'Checkin Account', rows: 2 });
    expect(p.accounts).toEqual([{ id: 'chk', name: 'Checking' }]);
    const r = await commitBalanceImport(c, opts);
    expect(r).toMatchObject({ inserted: 1, skipped: 2 });
  });

  describe('unmatched-name suggestions', () => {
    const unmatchedFor = async (name: string) =>
      (await previewBalanceImport(`date,account,balance\n2026-01-01,${name},1\n`, opts)).unmatched[0];

    it('suggests the account sharing a word, by id and name', async () => {
      await acct('sav', 'Savings');
      expect((await unmatchedFor('Checking Account')).suggestions).toEqual([{ id: 'chk', name: 'Checking' }]);
    });

    it('ranks by score, best first', async () => {
      await acct('a1', 'Chase Freedom');
      await acct('a2', 'Chase Sapphire Reserve');
      await acct('a3', 'Chase Sapphire');
      const s = (await unmatchedFor('Chase Sapphire Preferred')).suggestions;
      expect(s.slice(0, 2).map((x) => x.id).sort()).toEqual(['a2', 'a3']);
      expect(s[2].id).toBe('a1');
    });

    it('returns at most 3 suggestions', async () => {
      for (let i = 1; i <= 5; i++) await acct(`b${i}`, `Bank ${i}`);
      const s = (await unmatchedFor('Bank Card')).suggestions;
      expect(s).toHaveLength(3);
    });

    it('shows the nickname as the display name', async () => {
      await acct('n1', 'Plaid Gold Standard 0%', 'depository', 'Rainy Day Fund');
      expect((await unmatchedFor('Rainy Day')).suggestions).toEqual([{ id: 'n1', name: 'Rainy Day Fund' }]);
    });

    it('gives no suggestions when nothing shares a word or substring', async () => {
      await acct('sav', 'Savings');
      expect((await unmatchedFor('Zzyzx Holdings')).suggestions).toEqual([]);
    });
  });

  it('includes excluded accounts with a warning', async () => {
    await acct('x529', 'College 529', 'investment', null, 1);
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,College 529,5\n', opts);
    expect(p.valid).toBe(1);
    expect(p.warnings.join(' ')).toMatch(/excluded/i);
  });

  it('never creates accounts', async () => {
    await commitBalanceImport('date,account,balance\n2026-01-01,New Thing,5\n', opts);
    expect(Number((await db.execute('SELECT COUNT(*) c FROM accounts')).rows[0].c)).toBe(1);
  });

  it('keeps liability sign as written and warns on negative', async () => {
    await acct('cc', 'Card', 'credit');
    await acct('ln', 'Mortgage', 'loan');
    const c = 'date,account,balance\n2026-01-01,Card,500\n2026-01-01,Mortgage,"(300,000)"\n';
    const p = await previewBalanceImport(c, opts);
    expect(p.warnings.join(' ')).toMatch(/negative/);
    await commitBalanceImport(c, opts);
    expect(await history('cc')).toEqual([['2026-01-01', 500]]);
    expect(await history('ln')).toEqual([['2026-01-01', -300000]]);
    const clean = await previewBalanceImport('date,account,balance\n2026-01-02,Card,500\n', opts);
    expect(clean.warnings).toEqual([]);
  });

  it('does not warn about a negative balance on a non-liability account', async () => {
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Checking,-50\n', opts);
    expect(p.valid).toBe(1);
    expect(p.warnings).toEqual([]);
  });

  it('a nickname equal to its own name is not ambiguous', async () => {
    await acct('same', 'Rainy', 'depository', 'Rainy');
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Rainy,1\n', opts);
    expect(p.ambiguous).toEqual([]);
    expect(p.resolved[0].accountId).toBe('same');
  });

  it('accountMap id for a name that also matches an account wins', async () => {
    await acct('sav', 'Savings');
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Checking,1\n', { ...opts, accountMap: { checking: 'sav' } });
    expect(p.resolved).toHaveLength(1);
    expect(p.resolved[0]).toMatchObject({ csvName: 'Checking', accountId: 'sav' });
  });

  it('accountMap applies to the same csv name in different case', async () => {
    await acct('sav', 'Savings');
    const c = 'date,account,balance\n2026-01-01,Old Bank,1\n2026-01-02,OLD bank,2\n';
    const p = await previewBalanceImport(c, { ...opts, accountMap: { 'Old Bank': 'sav' } });
    expect(p.valid).toBe(2);
    expect(new Set(p.resolved.map((r) => r.accountId))).toEqual(new Set(['sav']));
  });

  it('a name mapped to null is reported as user_skipped', async () => {
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,Junk,1\n', { ...opts, accountMap: { junk: null } });
    expect(p.skipped.map((s) => s.reason)).toEqual(['user_skipped']);
    expect(p.unmatched).toEqual([]);
  });

  it('orders accounts and ambiguity candidates deterministically', async () => {
    await acct('z1', 'Zeta');
    await acct('b2', 'Visa');
    await acct('a1', 'Other', 'credit', 'visa');
    const p = await previewBalanceImport('date,account,balance\n2026-01-01,visa,1\n', opts);
    expect(p.accounts.map((a) => a.id)).toEqual(['chk', 'a1', 'b2', 'z1']);
    expect(p.ambiguous[0].candidates.map((c) => c.id)).toEqual(['a1', 'b2']);
  });

  it('commit is atomic: a mid-batch failure rolls everything back', async () => {
    await db.execute(`CREATE TRIGGER boom BEFORE INSERT ON balance_history WHEN NEW.balance = 666 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      const c = 'date,account,balance\n2026-01-01,Checking,1\n2026-01-02,Checking,666\n2026-01-03,Checking,3\n';
      await expect(commitBalanceImport(c, opts)).rejects.toThrow();
      expect(await history('chk')).toEqual([['2026-05-20', 5000]]);
    } finally {
      await db.execute('DROP TRIGGER boom');
    }
  });

  it('commits 10k rows', async () => {
    const lines = ['date,account,balance'];
    const start = Date.UTC(1990, 0, 1);
    for (let i = 0; i < 10_000; i++) {
      lines.push(`${new Date(start + i * 86400000).toISOString().slice(0, 10)},Checking,${i}`);
    }
    const r = await commitBalanceImport(lines.join('\n'), opts);
    expect(r.inserted).toBe(10_000);
  });
});

describe('skip copy', () => {
  it('has copy for every reason', () => {
    expect(Object.keys(BALANCE_IMPORT_SKIP_COPY).sort()).toEqual([...BALANCE_IMPORT_SKIP_REASONS].sort());
    expect(BALANCE_IMPORT_SKIP_COPY.no_matching_account).toBe('no matching account');
    expect(BALANCE_IMPORT_SKIP_COPY.ambiguous_account).toBe('ambiguous account name');
    expect(BALANCE_IMPORT_SKIP_COPY.newer_than_current).toBe('newer than the current balance');
    expect(BALANCE_IMPORT_SKIP_COPY.future_date).toBe('dated in the future');
    expect(BALANCE_IMPORT_SKIP_COPY.invalid_date).toBe('invalid date or amount');
    expect(BALANCE_IMPORT_SKIP_COPY.invalid_amount).toBe('invalid date or amount');
    expect(BALANCE_IMPORT_SKIP_COPY.missing_field).toBe('missing field');
    expect(BALANCE_IMPORT_SKIP_COPY.user_skipped).toBe('skipped by you');
  });

  it('summarizeSkips merges same copy, orders by first appearance, empty when none', () => {
    expect(summarizeSkips([])).toBe('');
    expect(summarizeSkips([
      { reason: 'no_matching_account' }, { reason: 'invalid_date' }, { reason: 'no_matching_account' }, { reason: 'invalid_amount' },
    ])).toBe('2 no matching account, 2 invalid date or amount');
    expect(summarizeSkips([{ reason: 'user_skipped' }])).toBe('1 skipped by you');
  });
});

describe('tools', () => {
  const csv = 'date,account,balance\n2026-01-01,Checking,100\n2026-01-02,Nowhere,5\n';

  it('import_balance_history is a write tool, preview is not', () => {
    expect(WRITE_TOOLS.has('import_balance_history')).toBe(true);
    expect(WRITE_TOOLS.has('preview_balance_import')).toBe(false);
  });

  it('preview_balance_import reports without writing', async () => {
    const out = await executeTool('preview_balance_import', { csv, today: TODAY });
    expect(out).toContain('no changes made');
    expect(out).toContain('Unmatched account "Nowhere"');
    expect(await count()).toBe(1);
  });

  it('import_balance_history writes and summarizes; confirmation text states counts', async () => {
    const desc = await describeToolCallDetailed('import_balance_history', { csv, today: TODAY });
    expect(desc).toBe('Import balance history: 1 new, 0 replacing existing (0 with a different value), 1 skipped');
    const out = await executeTool('import_balance_history', { csv, today: TODAY });
    expect(out).toContain('1 new, 0 overwritten, 1 skipped');
    expect(await count()).toBe(2);
  });

  it('reports a bad header without throwing', async () => {
    expect(await executeTool('import_balance_history', { csv: 'a,b\n1,2' })).toMatch(/nothing was written/);
  });

  describe('change notifications', () => {
    let notified: number;
    let off: () => void;
    beforeEach(() => { notified = 0; off = onRefresh(() => { notified++; }); });
    afterEach(() => { off(); });

    it('mid-batch failure: no notify, error string, no success claim', async () => {
      await db.execute(`CREATE TRIGGER boom2 BEFORE INSERT ON balance_history WHEN NEW.balance = 666 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
      try {
        const c = 'date,account,balance\n2026-01-01,Checking,1\n2026-01-02,Checking,666\n';
        const out = await executeTool('import_balance_history', { csv: c, today: TODAY });
        expect(out).toMatch(/^Import failed, nothing was written/);
        expect(out).not.toMatch(/^Imported/);
        expect(notified).toBe(0);
        expect(await count()).toBe(1);
      } finally {
        await db.execute('DROP TRIGGER boom2');
      }
    });

    it('all rows skipped: nothing written, no notify', async () => {
      const out = await executeTool('import_balance_history', { csv: 'date,account,balance\n2026-01-01,Nowhere,5\n', today: TODAY });
      expect(out).toContain('0 new, 0 overwritten, 1 skipped');
      expect(notified).toBe(0);
    });

    it('successful import notifies exactly once', async () => {
      await executeTool('import_balance_history', { csv, today: TODAY });
      expect(notified).toBe(1);
    });
  });

  it('surfaces the too-large message through the tools', async () => {
    const big = 'date,account,balance\n' + 'x'.repeat(5 * 1024 * 1024);
    expect(await executeTool('preview_balance_import', { csv: big })).toMatch(/too large/);
    expect(await executeTool('import_balance_history', { csv: big })).toMatch(/nothing was written.*too large/);
    const many = 'date,account,balance\n' + 'a,b,c\n'.repeat(50_001);
    expect(await executeTool('import_balance_history', { csv: many })).toMatch(/too many/);
  });
});

// The blocks below swap out or reset the module registry, so they come last
// and each puts the shared in-memory db mock back when done.
function restoreDbMock() {
  vi.doMock('../core/db.js', async () => {
    const { makeTestDb } = await import('./helpers/makeTestDb.js');
    return { db: await makeTestDb() };
  });
}

// The production schema (autoincrement id + unique index) differs from the
// test helper schema (composite PK); the upsert must work on both.
describe('balance import on the production schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bal-import-'));
  const prevDir = process.env.FUNGIBLE_DATA_DIR;

  afterAll(() => {
    if (prevDir === undefined) delete process.env.FUNGIBLE_DATA_DIR;
    else process.env.FUNGIBLE_DATA_DIR = prevDir;
    vi.resetModules();
    restoreDbMock();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upserts against the real initDb schema', async () => {
    process.env.FUNGIBLE_DATA_DIR = dir;
    vi.resetModules();
    vi.doUnmock('../core/db.js');
    const { db: realDb, initDb } = await import('../core/db.js');
    await initDb();
    await realDb.execute("INSERT INTO accounts (id, name, type) VALUES ('a', 'Checking', 'depository')");
    await realDb.execute("INSERT INTO balance_history (account_id, balance, date) VALUES ('a', 9, '2026-05-20')");
    const { commitBalanceImport: commit } = await import('../core/balance-import.js');
    await commit('date,account,balance\n2026-01-01,Checking,1\n', { today: '2026-06-01' });
    const r2 = await commit('date,account,balance\n2026-01-01,Checking,2\n', { today: '2026-06-01' });
    expect(r2.overwritten).toBe(1);
    const rows = (await realDb.execute("SELECT balance FROM balance_history WHERE account_id='a' AND date='2026-01-01'")).rows;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].balance)).toBe(2);
  });
});

describe('balance-import-copy', () => {
  afterAll(() => {
    vi.resetModules();
    restoreDbMock();
  });

  it('loads with db and refresh mocked to throw (no imports/side effects)', async () => {
    vi.resetModules();
    vi.doMock('../core/db.js', () => { throw new Error('db must not load'); });
    vi.doMock('../core/refresh.js', () => { throw new Error('refresh must not load'); });
    const copy = await import('../core/balance-import-copy.js');
    expect(copy.summarizeSkips([{ reason: 'invalid_date' }, { reason: 'invalid_amount' }])).toBe('2 invalid date or amount');
    expect(copy.BALANCE_IMPORT_SKIP_REASONS.length).toBe(8);
    vi.doUnmock('../core/db.js');
    vi.doUnmock('../core/refresh.js');
  });

  it('balance-import re-exports identical values', async () => {
    vi.resetModules();
    restoreDbMock();
    const copy = await import('../core/balance-import-copy.js');
    const main = await import('../core/balance-import.js');
    expect(main.BALANCE_IMPORT_SKIP_REASONS).toBe(copy.BALANCE_IMPORT_SKIP_REASONS);
    expect(main.BALANCE_IMPORT_SKIP_COPY).toBe(copy.BALANCE_IMPORT_SKIP_COPY);
    expect(main.summarizeSkips).toBe(copy.summarizeSkips);
  });
});
