import { describe, it, expect } from 'vitest';
import { makeTestDb } from './makeTestDb.js';
import { useFixedClock } from './fakeClock.js';
import { isoDaysAgo } from './dates.js';
import { seedManualAccount, seedCsvAccount, seedPlaidAccount } from './balanceFixtures.js';
import { frameHasColor, useForcedColor, SGR } from './ansi.js';
import chalk from 'chalk';

describe('fakeClock + dates', () => {
  useFixedClock();
  it('pins Date but not timers', async () => {
    expect(new Date().toISOString()).toBe('2026-10-02T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 5));
  });
  it('isoDaysAgo is UTC', () => {
    expect(isoDaysAgo(0)).toBe('2026-10-02');
    expect(isoDaysAgo(2)).toBe('2026-09-30');
    expect(isoDaysAgo(1, new Date('2026-01-01T00:30:00Z'))).toBe('2025-12-31');
  });
});

describe('balanceFixtures', () => {
  it('seeds the three kinds', async () => {
    const db = await makeTestDb();
    await seedManualAccount(db, { id: 'house', balanceDaysAgo: 3 });
    await seedCsvAccount(db, { id: 'csv-1', balanceDaysAgo: 10 });
    await seedPlaidAccount(db, { id: 'p1' });
    const rows = (await db.execute('SELECT id, item_id FROM accounts ORDER BY id')).rows;
    expect(rows.map((r) => [r.id, r.item_id])).toEqual([['csv-1', null], ['manual-house', null], ['p1', 'item-p1']]);
    expect((await db.execute('SELECT COUNT(*) c FROM balance_history')).rows[0].c).toBe(2);
    expect((await db.execute('SELECT COUNT(*) c FROM plaid_items')).rows[0].c).toBe(1);
    await expect(seedCsvAccount(db, { id: 'manual-x' })).rejects.toThrow();
  });
});

describe('ansi', () => {
  useForcedColor();
  it('detects the SGR around text', () => {
    const frame = `a ${chalk.yellow('updated 52d ago')} b ${chalk.red('x')}`;
    expect(frameHasColor(frame, 'updated 52d ago', SGR.yellow)).toBe(true);
    expect(frameHasColor(frame, 'updated 52d ago', SGR.red)).toBe(false);
    expect(frameHasColor(frame, 'x', SGR.red)).toBe(true);
  });
});
