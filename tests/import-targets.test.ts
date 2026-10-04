import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { getImportTargets } from '../core/queries.js';

async function acct(id: string, name: string, opts: { item_id?: string | null; institution_name?: string | null; nickname?: string | null; mask?: string | null } = {}) {
  await db.execute({
    sql: 'INSERT INTO accounts (id, name, type, item_id, institution_name, nickname, mask) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [id, name, 'depository', opts.item_id ?? null, opts.institution_name ?? null, opts.nickname ?? null, opts.mask ?? null],
  });
}
async function item(item_id: string, institution_name: string | null, days: number | null) {
  await db.execute({
    sql: 'INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested) VALUES (?, ?, ?, ?)',
    args: [item_id, 'tok', institution_name, days],
  });
}
async function tx(id: string, account_id: string, date: string) {
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category) VALUES (?, ?, ?, 'x', 1, 'Other')`,
    args: [id, account_id, date],
  });
}

beforeEach(async () => {
  for (const t of ['transactions', 'accounts', 'plaid_items']) await db.execute(`DELETE FROM ${t}`);
});

describe('getImportTargets', () => {
  it('returns [] on an empty database', async () => {
    expect(await getImportTargets()).toEqual([]);
  });

  it('derives kind: item_id wins over the manual- prefix, manual- prefix beats csv', async () => {
    await item('item1', 'Chase', 730);
    await acct('p1', 'B plaid', { item_id: 'item1' });
    await acct('manual-1', 'C manual');
    await acct('csv-1', 'A csv');
    // A linked account whose id happens to carry the manual- prefix is still plaid.
    await acct('manual-linked', 'D linked', { item_id: 'item1' });
    // The prefix must be at the start, not merely contained.
    await acct('my-manual-thing', 'E');
    await acct('manualx', 'F');
    const kinds = Object.fromEntries((await getImportTargets()).map((t) => [t.id, t.kind]));
    expect(kinds).toEqual({ p1: 'plaid', 'manual-1': 'manual', 'csv-1': 'csv', 'manual-linked': 'plaid', 'my-manual-thing': 'csv', manualx: 'csv' });
  });

  it('days_requested is a number for plaid accounts and null without a plaid_items row or when the column is NULL', async () => {
    await item('item1', 'Chase', 730);
    await item('item2', 'Old', null);
    await acct('a', 'A', { item_id: 'item1' });
    await acct('b', 'B', { item_id: 'item2' });
    await acct('c', 'C');
    await acct('d', 'D', { item_id: 'dangling-item' });
    const by = Object.fromEntries((await getImportTargets()).map((t) => [t.id, t.days_requested]));
    expect(by.a).toBe(730);
    expect(typeof by.a).toBe('number');
    expect(by.b).toBeNull();
    expect(by.c).toBeNull();
    expect(by.d).toBeNull();
  });

  it('earliest_date is the MIN transaction date per account, null with none', async () => {
    await acct('a', 'A');
    await acct('b', 'B');
    await tx('t1', 'a', '2025-03-01');
    await tx('t2', 'a', '2024-12-31');
    await tx('t3', 'a', '2025-06-01');
    await tx('t4', 'b', '2025-02-02');
    await acct('c', 'C');
    const by = Object.fromEntries((await getImportTargets()).map((t) => [t.id, t.earliest_date]));
    expect(by).toEqual({ a: '2024-12-31', b: '2025-02-02', c: null });
  });

  it("institution_name prefers the account's own over the plaid item's, falls back to the item's, else null", async () => {
    await item('item1', 'Item Bank', 90);
    await acct('own', 'A', { item_id: 'item1', institution_name: 'Own Bank' });
    await acct('fallback', 'B', { item_id: 'item1' });
    await acct('none', 'C');
    const by = Object.fromEntries((await getImportTargets()).map((t) => [t.id, t.institution_name]));
    expect(by).toEqual({ own: 'Own Bank', fallback: 'Item Bank', none: null });
  });

  it('is ordered by name and carries nickname/mask through', async () => {
    // ids sort opposite to names so ORDER BY id would fail
    await acct('a', 'Zeta');
    await acct('z', 'Alpha', { nickname: 'Nick', mask: '1234' });
    await acct('m', 'Mid');
    const res = await getImportTargets();
    expect(res.map((t) => t.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
    expect(res[0]).toMatchObject({ nickname: 'Nick', mask: '1234' });
  });

  it('is structuredClone-safe (plain JSON-like values only, no bigint)', async () => {
    await item('item1', 'Chase', 730);
    await acct('a', 'A', { item_id: 'item1' });
    await tx('t1', 'a', '2025-01-01');
    const res = await getImportTargets();
    expect(structuredClone(res)).toEqual(res);
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
  });
});
