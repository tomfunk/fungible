import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { countPatternMatches } from '../core/rule-utils.js';

let txId = 0;
async function insertTx(name: string, merchant_name?: string) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, pending, ignored)
          VALUES (?, 'a', '2025-01-01', ?, ?, 10, 'Shopping', 0, 0)`,
    args: [`tx${txId}`, name, merchant_name ?? null],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
});

describe('countPatternMatches', () => {
  it('returns 0 for empty pattern', async () => {
    await insertTx('Spotify');
    expect(await countPatternMatches('', 'name')).toBe(0);
  });

  it('counts substring matches (name type)', async () => {
    await insertTx('Spotify Monthly');
    await insertTx('Spotify Annual');
    await insertTx('Netflix');
    expect(await countPatternMatches('Spotify', 'name')).toBe(2);
  });

  it('matches against merchant_name too', async () => {
    await insertTx('AMZN Mktp', 'Amazon');
    expect(await countPatternMatches('Amazon', 'name')).toBe(1);
  });

  it('is case-insensitive for name matches', async () => {
    await insertTx('SPOTIFY');
    expect(await countPatternMatches('spotify', 'name')).toBe(1);
  });

  it('counts regex matches', async () => {
    await insertTx('Spotify Monthly');
    await insertTx('Spotify Annual');
    await insertTx('Netflix');
    expect(await countPatternMatches('^Spotify', 'regex')).toBe(2);
    expect(await countPatternMatches('^Netflix', 'regex')).toBe(1);
  });

  it('returns 0 for invalid regex without throwing', async () => {
    expect(await countPatternMatches('[invalid', 'regex')).toBe(0);
  });

  it('returns 0 when no transactions match', async () => {
    await insertTx('Netflix');
    expect(await countPatternMatches('Spotify', 'name')).toBe(0);
  });
});
