import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { parseCsvAmount } from '../core/csv-amount.js';
import { parseCsvText } from '../core/csv.js';
import { importCsvTransactions } from '../core/accounts.js';
import { applyTagRules } from '../core/tag-rules.js';
import { applyCategoriesToAll } from '../core/categorize.js';
import { makeCsvRow } from './helpers/makeCsvRow.js';
import { mulberry32, int, pick } from './helpers/prng.js';

// Property-style tests with a small seeded PRNG (no fast-check dependency).
// The seed is in every failure message: re-run with it to reproduce.
const SEED = 20261003;

// ---------------------------------------------------------------------------
// There is no normalizeAmount in core: amounts are never rounded on import, the
// CSV path parses via parseCsvAmount and the dedup key reduces to integer cents.
// There is also no split/proration helper. These properties cover what exists.
// ---------------------------------------------------------------------------
function format(cents: number, style: 'plain' | 'dollar' | 'comma' | 'parens' | 'trim'): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  switch (style) {
    case 'plain': return `${neg ? '-' : ''}${whole}.${frac}`;
    case 'dollar': return `${neg ? '-' : ''}$${whole}.${frac}`;
    case 'comma': return `${neg ? '-' : ''}$${grouped}.${frac}`;
    case 'parens': return neg ? `(${grouped}.${frac})` : `${grouped}.${frac}`;
    case 'trim': return `${neg ? '-' : ''}${whole}${frac === '00' ? '' : '.' + frac.replace(/0$/, '')}`;
  }
}

describe('parseCsvAmount properties', () => {
  it('format -> parse round-trips random cents across formats', () => {
    const r = mulberry32(SEED);
    const styles = ['plain', 'dollar', 'comma', 'parens', 'trim'] as const;
    for (let i = 0; i < 500; i++) {
      const mag = pick(r, [1e3, 1e5, 1e8, 1e11]);
      const cents = int(r, -mag, mag);
      const style = pick(r, styles);
      const s = format(cents, style);
      const got = parseCsvAmount(s);
      expect(got, `seed=${SEED} case=${i} cents=${cents} style=${style} s=${JSON.stringify(s)}`).toBe(cents / 100 + 0);
      expect(Object.is(got, -0), `seed=${SEED} -0 for ${s}`).toBe(false);
    }
  });

  it('negative zero spellings never yield -0', () => {
    for (const s of ['-0', '-0.00', '(0.00)', '$-0', '-$0.00', '(0)']) {
      expect(Object.is(parseCsvAmount(s), 0), s).toBe(true);
    }
  });

  it.each(['1,23', '1.2.3', '--5', '5-', '(5', '1,2345', 'abc', '$', '()'])('rejects hand-picked junk %j', (s) => {
    expect(parseCsvAmount(s)).toBeNull();
  });

  it('strings containing a letter or other junk never parse to a number', () => {
    const r = mulberry32(SEED + 1);
    const alphabet = '0123456789$,.-()+ abcxyzE€£%';
    for (let i = 0; i < 500; i++) {
      let s = '';
      const len = int(r, 1, 10);
      for (let k = 0; k < len; k++) s += alphabet[int(r, 0, alphabet.length - 1)];
      const got = parseCsvAmount(s);
      if (/[a-zA-Z€£%]/.test(s)) {
        expect(got, `seed=${SEED + 1} case=${i} s=${JSON.stringify(s)}`).toBeNull();
      } else if (got !== null) {
        // Anything accepted must be a finite, non-negative-zero number.
        expect(Number.isFinite(got), `seed=${SEED + 1} s=${JSON.stringify(s)}`).toBe(true);
        expect(Object.is(got, -0), `seed=${SEED + 1} s=${JSON.stringify(s)}`).toBe(false);
      }
    }
  });

  it('parse is stable: re-formatting a parsed value and parsing again gives the same number', () => {
    const r = mulberry32(SEED + 2);
    for (let i = 0; i < 300; i++) {
      const cents = int(r, -1e9, 1e9);
      const once = parseCsvAmount(format(cents, 'plain'))!;
      const twice = parseCsvAmount(format(Math.round(once * 100), 'comma'))!;
      expect(twice, `seed=${SEED + 2} cents=${cents}`).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Re-import idempotence. Semantics pinned: duplicates WITHIN one file are kept
// (each occurrence gets an ordinal), and re-importing the same file adds zero.
// ---------------------------------------------------------------------------
const CFG = makeCsvRow();
const countTx = async () => Number((await db.execute('SELECT COUNT(*) AS n FROM transactions')).rows[0].n);

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions', 'imports', 'accounts', 'balance_history', 'category_rules']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute(`INSERT INTO accounts (id, name, type) VALUES ('acc', 'acc', 'credit')`);
});

describe('CSV re-import properties', () => {
  it('CURRENT BEHAVIOUR: identical rows inside one file all import, each with an ordinal (do not \'fix\' without a product decision)', async () => {
    const parsed = parseCsvText('Date,Name,Amount\n2025-01-02,Coffee,4.50\n2025-01-02,Coffee,4.50\n2025-01-02,Coffee,4.50');
    const r = await importCsvTransactions(parsed.rows, 'acc', CFG, { name: 'd.csv', hash: 'hd' }, parsed.lines);
    expect(r.imported).toBe(3);
    const keys = (await db.execute('SELECT dedup_key FROM transactions ORDER BY dedup_key')).rows.map((x) => x.dedup_key);
    expect(keys).toEqual(['2025-01-02|coffee|450|0', '2025-01-02|coffee|450|1', '2025-01-02|coffee|450|2']);
  });

  it('importing a random file twice adds zero rows on the second pass', async () => {
    const r = mulberry32(SEED + 3);
    const names = ['Coffee', 'coffee ', 'Rent', 'Amazon, Inc.', 'Shop "X"'];
    const dates = ['2025-01-02', '2025-01-03', '2025-02-10'];
    const amounts = ['4.50', '-4.50', '$1,000.00', '(20.00)', '4.5'];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    for (let i = 0; i < 40; i++) {
      await db.execute('DELETE FROM transactions');
      await db.execute('DELETE FROM imports');
      const n = int(r, 1, 12);
      const lines = ['Date,Name,Amount'];
      for (let k = 0; k < n; k++) lines.push(`${pick(r, dates)},${q(pick(r, names))},${q(pick(r, amounts))}`);
      const parsed = parseCsvText(lines.join('\n'));
      const msg = `seed=${SEED + 3} case=${i} csv=${JSON.stringify(lines)}`;
      const first = await importCsvTransactions(parsed.rows, 'acc', CFG, { name: 'f.csv', hash: `h${i}` }, parsed.lines);
      expect(first.imported, msg).toBe(n);
      expect(await countTx(), msg).toBe(n);
      const second = await importCsvTransactions(parsed.rows, 'acc', CFG, { name: 'f.csv', hash: `h${i}` }, parsed.lines);
      expect(second.imported, msg).toBe(0);
      expect(await countTx(), msg).toBe(n);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule application idempotence.
// ---------------------------------------------------------------------------
describe('rule application idempotence', () => {
  it('applyTagRules twice leaves identical rows and inserts nothing the second time', async () => {
    const r = mulberry32(SEED + 4);
    for (let i = 0; i < 25; i++) {
      for (const t of ['transaction_tags', 'tag_rules', 'tags', 'transactions']) await db.execute(`DELETE FROM ${t}`);
      const tagIds: number[] = [];
      for (const nm of ['t1', 't2', 't3']) {
        tagIds.push(Number((await db.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: [nm] })).lastInsertRowid));
      }
      const pats = ['cof', 'rent', 'amaz', ''];
      for (let k = 0; k < int(r, 1, 4); k++) {
        const mt = pick(r, ['name', 'all'] as const);
        await db.execute({
          sql: 'INSERT INTO tag_rules (priority, match_type, pattern, tag_id, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)',
          args: [10, mt, mt === 'all' ? '' : pick(r, pats), pick(r, tagIds), r() < 0.3 ? 5 : null, r() < 0.3 ? 500 : null],
        });
      }
      for (let k = 0; k < int(r, 1, 15); k++) {
        await db.execute({
          sql: `INSERT INTO transactions (id, account_id, date, name, amount, category) VALUES (?, 'acc', '2025-01-01', ?, ?, 'Uncategorized')`,
          args: [`t${k}`, pick(r, ['Coffee Shop', 'Rent Co', 'Amazon', 'Other']), int(r, -100000, 100000) / 100],
        });
      }
      const snap = async () => (await db.execute('SELECT transaction_id, tag_id FROM transaction_tags ORDER BY 1, 2')).rows.map((x) => [x.transaction_id, Number(x.tag_id)]);
      await applyTagRules();
      const before = await snap();
      const again = await applyTagRules();
      expect(again, `seed=${SEED + 4} case=${i}`).toBe(0);
      expect(await snap(), `seed=${SEED + 4} case=${i}`).toEqual(before);
    }
  });

  it('applyCategoriesToAll twice changes nothing the second time', async () => {
    const r = mulberry32(SEED + 5);
    for (let i = 0; i < 25; i++) {
      for (const t of ['category_rules', 'transactions']) await db.execute(`DELETE FROM ${t}`);
      for (let k = 0; k < int(r, 1, 4); k++) {
        await db.execute({
          sql: 'INSERT INTO category_rules (priority, match_type, pattern, category, min_amount, max_amount) VALUES (?, ?, ?, ?, ?, ?)',
          args: [int(r, 1, 20), 'name', pick(r, ['cof', 'rent', 'amaz']), pick(r, ['Food', 'Housing', 'Shopping']), r() < 0.3 ? 5 : null, null],
        });
      }
      for (let k = 0; k < int(r, 1, 15); k++) {
        await db.execute({
          sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, manual_category) VALUES (?, 'acc', '2025-01-01', ?, ?, 'Uncategorized', ?)`,
          args: [`t${k}`, pick(r, ['Coffee Shop', 'Rent Co', 'Amazon', 'Other']), int(r, -100000, 100000) / 100, r() < 0.2 ? 'Pinned' : null],
        });
      }
      const snap = async () => (await db.execute('SELECT id, category, manual_category FROM transactions ORDER BY id')).rows.map((x) => ({ ...x }));
      await applyCategoriesToAll();
      const before = await snap();
      const again = await applyCategoriesToAll();
      expect(again, `seed=${SEED + 5} case=${i}`).toBe(0);
      expect(await snap(), `seed=${SEED + 5} case=${i}`).toEqual(before);
    }
  });
});
