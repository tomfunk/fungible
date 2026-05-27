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
  db.prepare(`
    INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
    VALUES (?, 'a', '2025-01-01', ?, ?, 10, 'Shopping', 0, 0)
  `).run(`tx${txId}`, name, merchant_name ?? null);
}

beforeEach(() => {
  txId = 0;
  db.exec('DELETE FROM transactions');
});

describe('countPatternMatches', () => {
  it('returns 0 for empty pattern', () => {
    insertTx('Spotify');
    expect(countPatternMatches('', 'name')).toBe(0);
  });

  it('counts substring matches (name type)', () => {
    insertTx('Spotify Monthly');
    insertTx('Spotify Annual');
    insertTx('Netflix');
    expect(countPatternMatches('Spotify', 'name')).toBe(2);
  });

  it('matches against merchant_name too', () => {
    insertTx('AMZN Mktp', 'Amazon');
    expect(countPatternMatches('Amazon', 'name')).toBe(1);
  });

  it('is case-insensitive for name matches', () => {
    insertTx('SPOTIFY');
    expect(countPatternMatches('spotify', 'name')).toBe(1);
  });

  it('counts regex matches', () => {
    insertTx('Spotify Monthly');
    insertTx('Spotify Annual');
    insertTx('Netflix');
    expect(countPatternMatches('^Spotify', 'regex')).toBe(2);
    expect(countPatternMatches('^Netflix', 'regex')).toBe(1);
  });

  it('returns 0 for invalid regex without throwing', () => {
    expect(countPatternMatches('[invalid', 'regex')).toBe(0);
  });

  it('returns 0 when no transactions match', () => {
    insertTx('Netflix');
    expect(countPatternMatches('Spotify', 'name')).toBe(0);
  });
});
