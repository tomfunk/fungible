import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { seedTx } from './helpers/seedDb.js';
import { getOrCreateTag, renameTag, deleteTag, addTagToTransactions, removeTagFromTransaction } from '../core/tags.js';
import {
  getSplitConfig, setupSplit, getSettleMonths, settleMonth, unsettleMonth,
  getRatios, addRatio, updateRatio, deleteRatio, countTransactionsTagged,
} from '../core/split.js';

const TODAY = '2026-11-15';
const SETUP = { jointTagName: 'joint', settledTagName: 'settled', selfPct: 60, startDate: '2026-01-01' };

async function seedHousehold(spouse: string | null = 'Alex') {
  await db.execute("INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('self', 'Pat', 1985, 0)");
  if (spouse) {
    await db.execute({ sql: "INSERT INTO household_members (id, name, birth_year, sort_order) VALUES ('spouse', ?, 1986, 1)", args: [spouse] });
  }
}

/** A posted transaction on Pat's or Alex's account, tagged joint unless told otherwise. */
async function jointTx(overrides: Parameters<typeof seedTx>[1] = {}, opts: { joint?: boolean } = {}) {
  const tx = await seedTx(db, { account_id: 'acct-pat', date: '2026-10-05', amount: 100, ...overrides });
  if (opts.joint !== false) await addTagToTransactions([tx.id], await getOrCreateTag('joint'));
  return tx;
}

async function october() {
  const m = (await getSettleMonths(TODAY)).find((x) => x.month === '2026-10');
  if (!m) throw new Error('no October summary');
  return m;
}

async function tagNamesOf(txId: string): Promise<string[]> {
  const r = await db.execute({
    sql: 'SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.transaction_id = ? ORDER BY tg.name',
    args: [txId],
  });
  return r.rows.map((x) => String(x.name));
}

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tags', 'transactions', 'accounts', 'settings', 'split_ratios', 'household_members', 'hidden_categories']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch([
    "INSERT INTO accounts (id, name, type, owner) VALUES ('acct-pat', 'Pat card', 'credit', 'Pat')",
    "INSERT INTO accounts (id, name, type, owner) VALUES ('acct-alex', 'Alex card', 'credit', 'Alex')",
    "INSERT INTO accounts (id, name, type, owner) VALUES ('acct-none', 'Shared', 'depository', NULL)",
    "INSERT INTO hidden_categories (category) VALUES ('Transfer')",
  ], 'write');
});

describe('getSplitConfig', () => {
  it('needs the household when there is no spouse', async () => {
    await seedHousehold(null);
    expect((await getSplitConfig()).status).toBe('needs-household');
  });

  it('is unconfigured until setup runs, then ready', async () => {
    await seedHousehold();
    expect(await getSplitConfig()).toEqual({ status: 'unconfigured', self: 'Pat', spouse: 'Alex' });
    await setupSplit(SETUP);
    const config = await getSplitConfig();
    expect(config.status).toBe('ready');
    if (config.status !== 'ready') return;
    expect(config.jointTag.name).toBe('joint');
    expect(config.settledTag.name).toBe('settled');
    expect(config.ratios).toEqual([{ startDate: '2026-01-01', selfPct: 60 }]);
  });

  it('keeps working after a tag is renamed on the Tags screen', async () => {
    await seedHousehold();
    await setupSplit(SETUP);
    await renameTag(await getOrCreateTag('joint'), 'shared');
    const config = await getSplitConfig();
    expect(config.status === 'ready' && config.jointTag.name).toBe('shared');
  });

  it('goes back to unconfigured when a configured tag is gone', async () => {
    await seedHousehold();
    await setupSplit(SETUP);
    // deleteTag refuses (below); this is a tag removed some other way, e.g. by hand in SQL.
    await db.execute({ sql: 'DELETE FROM tags WHERE id = ?', args: [await getOrCreateTag('settled')] });
    expect((await getSplitConfig()).status).toBe('unconfigured');
  });

  it("refuses to delete either of the split's tags, but not other tags", async () => {
    await seedHousehold();
    await setupSplit(SETUP);
    await expect(deleteTag(await getOrCreateTag('joint'))).rejects.toThrow("used by expense splitting");
    await expect(deleteTag(await getOrCreateTag('settled'))).rejects.toThrow("used by expense splitting");
    await deleteTag(await getOrCreateTag('vacation'));
    expect((await getSplitConfig()).status).toBe('ready');
  });
});

describe('setupSplit', () => {
  beforeEach(() => seedHousehold());

  it('reuses an existing tag instead of creating a second one', async () => {
    const existing = await getOrCreateTag('joint');
    await setupSplit(SETUP);
    const config = await getSplitConfig();
    expect(config.status === 'ready' && config.jointTag.id).toBe(existing);
  });

  it.each([
    [{ jointTagName: ' ' }, 'Both tag names are required'],
    [{ settledTagName: 'joint' }, 'must be different'],
    [{ selfPct: 101 }, 'between 0 and 100'],
    [{ selfPct: Number.NaN }, 'between 0 and 100'],
    [{ startDate: '2026-02-30' }, 'YYYY-MM-DD'],
  ])('rejects %o', async (change, message) => {
    await expect(setupSplit({ ...SETUP, ...change })).rejects.toThrow(message);
    expect((await getSplitConfig()).status).toBe('unconfigured');
  });

  it('refuses a start date on or before a transaction already carrying the settled tag', async () => {
    const tx = await jointTx({ date: '2026-03-10' });
    await addTagToTransactions([tx.id], await getOrCreateTag('settled'));
    expect(await countTransactionsTagged('settled')).toBe(1);
    await expect(setupSplit(SETUP)).rejects.toThrow('2026-03-10');
    await setupSplit({ ...SETUP, startDate: '2026-03-11' });
    expect((await getSplitConfig()).status).toBe('ready');
  });
});

describe('getSettleMonths', () => {
  beforeEach(async () => {
    await seedHousehold();
    await setupSplit(SETUP);
  });

  it('is empty until the split is configured', async () => {
    await db.execute('DELETE FROM split_ratios');
    expect(await getSettleMonths(TODAY)).toEqual([]);
  });

  it("splits a month's joint expenses by account owner", async () => {
    await jointTx({ amount: 1100 });
    await jointTx({ account_id: 'acct-alex', amount: 1900 });
    const m = await october();
    expect(m.spouseOwesSelf).toBe(440);
    expect(m.selfOwesSpouse).toBe(1140);
    expect(m.toSettle).toBe(-700);
  });

  it('nets refunds and leaves out untagged, pending, ignored and hidden-category transactions', async () => {
    await jointTx({ amount: 100 });
    await jointTx({ amount: -25 });
    await jointTx({ amount: 1000 }, { joint: false });
    await jointTx({ amount: 1000, pending: true });
    await jointTx({ amount: 1000, ignored: true });
    await jointTx({ amount: 1000, category: 'Transfer' });
    const m = await october();
    expect(m.selfPaid).toBe(75);
    expect(m.pendingCount).toBe(1);
    expect(m.hiddenCount).toBe(1);
  });

  it('ignores transactions dated before the first ratio', async () => {
    await db.execute("UPDATE split_ratios SET start_date = '2026-10-10'");
    await jointTx({ date: '2026-10-09', amount: 500 });
    await jointTx({ date: '2026-10-10', amount: 100 });
    expect((await october()).selfPaid).toBe(100);
  });

  it('blocks a joint expense on an account with no owner', async () => {
    const tx = await jointTx({ account_id: 'acct-none' });
    expect((await october()).blockedIds).toEqual([tx.id]);
  });
});

describe('settleMonth / unsettleMonth', () => {
  beforeEach(async () => {
    await seedHousehold();
    await setupSplit(SETUP);
  });

  it('tags the shown transactions, then a late one shows up as a top-up for only its amount', async () => {
    await jointTx({ amount: 100 });
    await jointTx({ account_id: 'acct-alex', amount: 50 });
    const before = await october();
    await settleMonth(before.tagIds, before.untagIds);
    expect((await october()).status).toBe('settled');

    await jointTx({ date: '2026-10-28', amount: 31 });
    const after = await october();
    expect(after.status).toBe('top-up');
    expect(after.alreadySettled).toBe(10);
    expect(after.toSettle).toBe(12.4);
  });

  it('tags only the ids it was given, so a transaction that arrives mid-prompt stays unsettled', async () => {
    await jointTx();
    const shown = await october();
    const arrived = await jointTx({ amount: 77 });
    await settleMonth(shown.tagIds, shown.untagIds);
    expect(await tagNamesOf(arrived.id)).toEqual(['joint']);
    expect((await october()).tagIds).toEqual([arrived.id]);
  });

  it('reverses a settled transaction whose joint tag was removed, then untags it when settled again', async () => {
    const tx = await jointTx({ amount: 100 });
    const m = await october();
    await settleMonth(m.tagIds, m.untagIds);
    await removeTagFromTransaction(tx.id, await getOrCreateTag('joint'));

    const reversed = await october();
    expect(reversed.untagIds).toEqual([tx.id]);
    expect(reversed.toSettle).toBe(-40);
    await settleMonth(reversed.tagIds, reversed.untagIds);
    expect(await tagNamesOf(tx.id)).toEqual([]);
  });

  it('unsettles only the chosen month', async () => {
    const oct = await jointTx({ date: '2026-10-05' });
    const sep = await jointTx({ date: '2026-09-05' });
    for (const m of await getSettleMonths(TODAY)) await settleMonth(m.tagIds, m.untagIds);
    await unsettleMonth('2026-10');
    expect(await tagNamesOf(oct.id)).toEqual(['joint']);
    expect(await tagNamesOf(sep.id)).toEqual(['joint', 'settled']);
  });

  it('refuses to settle before the split is set up', async () => {
    await db.execute('DELETE FROM settings');
    await expect(settleMonth(['x'], [])).rejects.toThrow('not set up');
  });
});

describe('ratios', () => {
  beforeEach(async () => {
    await seedHousehold();
    await setupSplit(SETUP);
    const tx = await jointTx({ date: '2026-09-30' });
    await settleMonth([tx.id], []);
  });

  it('adds a ratio that starts after the latest settled transaction', async () => {
    await addRatio('2026-10-01', 55);
    expect(await getRatios()).toEqual([
      { startDate: '2026-01-01', selfPct: 60 },
      { startDate: '2026-10-01', selfPct: 55 },
    ]);
  });

  it('refuses to back-date a ratio over a settled transaction', async () => {
    await expect(addRatio('2026-09-30', 55)).rejects.toThrow("can't change on or before 2026-09-30");
    await expect(updateRatio('2026-01-01', '2026-01-01', 50)).rejects.toThrow('2026-09-30');
    await addRatio('2026-11-01', 55);
    await expect(updateRatio('2026-11-01', '2026-09-01', 55)).rejects.toThrow('2026-09-30');
  });

  it('edits and deletes ratios that start after the latest settled transaction', async () => {
    await addRatio('2026-11-01', 55);
    await updateRatio('2026-11-01', '2026-11-15', 52.5);
    expect((await getRatios())[1]).toEqual({ startDate: '2026-11-15', selfPct: 52.5 });
    await deleteRatio('2026-11-15');
    expect(await getRatios()).toHaveLength(1);
  });

  it('refuses a duplicate start date and deleting the only ratio', async () => {
    await addRatio('2026-11-01', 55);
    await expect(addRatio('2026-11-01', 50)).rejects.toThrow('already starts on 2026-11-01');
    await db.execute('DELETE FROM transaction_tags');
    await deleteRatio('2026-11-01');
    await expect(deleteRatio('2026-01-01')).rejects.toThrow('only ratio');
  });
});
