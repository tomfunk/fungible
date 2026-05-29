import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: makeTestDb() };
});

import { db } from '../core/db.js';
import { countPatternMatches } from '../core/rule-utils.js';

let txId = 0;
function insertTx(name: string, merchant_name?: string) {
  txId++;
  (db as any).prepare(`
    INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
    VALUES (?, 'a', '2025-01-01', ?, ?, 10, 'Shopping', 0, 0)
  `).run(`tx${txId}`, name, merchant_name ?? null);
}

beforeEach(() => {
  txId = 0;
  (db as any).exec('DELETE FROM transactions');
});

describe('countPatternMatches', () => {
  it('returns 0 for empty pattern', async () => {
    insertTx('Spotify');
    expect(await countPatternMatches('', 'name')).toBe(0);
  });

  it('counts substring matches (name type)', async () => {
    insertTx('Spotify Monthly');
    insertTx('Spotify Annual');
    insertTx('Netflix');
    expect(await countPatternMatches('Spotify', 'name')).toBe(2);
  });

  it('matches against merchant_name too', async () => {
    insertTx('AMZN Mktp', 'Amazon');
    expect(await countPatternMatches('Amazon', 'name')).toBe(1);
  });

  it('is case-insensitive for name matches', async () => {
    insertTx('SPOTIFY');
    expect(await countPatternMatches('spotify', 'name')).toBe(1);
  });

  it('counts regex matches', async () => {
    insertTx('Spotify Monthly');
    insertTx('Spotify Annual');
    insertTx('Netflix');
    expect(await countPatternMatches('^Spotify', 'regex')).toBe(2);
    expect(await countPatternMatches('^Netflix', 'regex')).toBe(1);
  });

  it('returns 0 for invalid regex without throwing', async () => {
    expect(await countPatternMatches('[invalid', 'regex')).toBe(0);
  });

  it('returns 0 when no transactions match', async () => {
    insertTx('Netflix');
    expect(await countPatternMatches('Spotify', 'name')).toBe(0);
  });
});
