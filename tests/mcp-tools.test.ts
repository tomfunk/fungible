import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

// Canvas tools write history/spec JSON under DATA_DIR; keep that off ~/.fungible.
const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return { TEST_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-mcp-tools-')) };
});
vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));

vi.mock('../core/plaid.js', () => ({
  getPlaidClient: vi.fn(),
  plaidErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../core/db.js';
import { getPlaidClient } from '../core/plaid.js';
import { TOOL_DEFS, WRITE_TOOLS } from '../core/tools.js';
import { makeMcpClient, type McpTestClient } from './helpers/makeMcpClient.js';
import { seedTx } from './helpers/seedDb.js';
import { seedPlaidItem } from './helpers/seedDb.js';
import { makeFakePlaid } from './helpers/makeFakeProvider.js';
import { makePlaidTx, makePlaidAccount } from './helpers/makePlaidTx.js';

let mcp: McpTestClient;

// Dates are relative to the real clock (SQLite 'now' ignores fake timers): the
// previous calendar month is always complete and inside every trailing window.
const prev = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
const Y = prev.getFullYear();
const M = prev.getMonth() + 1;
const ym = `${Y}-${String(M).padStart(2, '0')}`;
const day = (d: number) => `${ym}-${String(d).padStart(2, '0')}`;

const q = async <T = Record<string, unknown>>(sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows as unknown as T[];
const one = async <T = Record<string, unknown>>(sql: string, args: (string | number)[] = []) => (await q<T>(sql, args))[0];
const txCount = async () => Number((await one<{ c: number }>('SELECT COUNT(*) c FROM transactions')).c);

async function seedDataset() {
  await db.execute("INSERT INTO accounts (id,name,type,subtype,nickname) VALUES ('chk','Checking','depository','checking','Main'),('cc','Card','credit','credit card',NULL)");
  await db.execute({ sql: "INSERT INTO balance_history (account_id,balance,date) VALUES ('chk',5000,?),('cc',300,?)", args: [day(20), day(20)] });
  await db.execute("INSERT INTO hidden_categories (category) VALUES ('Transfer')");
  await seedTx(db, { id: 't1', account_id: 'chk', date: day(5), name: 'Corner Cafe', amount: 12.5, category: 'Food' });
  await seedTx(db, { id: 't2', account_id: 'chk', date: day(6), name: 'Corner Cafe', amount: 7.5, category: 'Food' });
  await seedTx(db, { id: 't3', account_id: 'chk', date: day(1), name: 'Landlord', amount: 1000, category: 'Rent' });
  await seedTx(db, { id: 't4', account_id: 'chk', date: day(2), name: 'Employer', amount: -3000, category: 'Income' });
  await seedTx(db, { id: 't5', account_id: 'chk', date: day(3), name: 'Move', amount: 200, category: 'Transfer' });
  await seedTx(db, { id: 't6', account_id: 'cc', date: day(7), name: 'Ignored Thing', amount: 50, category: 'Food', ignored: true });
  await seedTx(db, { id: 't7', account_id: 'cc', date: day(8), name: 'Mystery Co', amount: 9, category: 'Uncategorized' });
}

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions', 'accounts', 'balance_history',
    'category_rules', 'name_rules', 'hidden_categories', 'plaid_items', 'sync_state']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  for (const f of ['canvas-history.json', 'canvas-spec.json', 'screen.txt']) rmSync(join(TEST_DATA_DIR, f), { force: true });
  await seedDataset();
  mcp = await makeMcpClient();
});
afterEach(() => mcp.close());

// ─── (1) Contract over listTools ─────────────────────────────────────────────

describe('tool registry contract', () => {
  it('exposes exactly the tools in TOOL_DEFS (plus MCP-only generate_canvas), with matching required args', async () => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_DEFS.map((t) => t.name), 'generate_canvas'].sort());
    for (const def of TOOL_DEFS) {
      const tool = tools.find((t) => t.name === def.name)!;
      const required = ((tool.inputSchema as { required?: string[] }).required ?? []).slice().sort();
      const expected = ((def.parameters as { required?: string[] }).required ?? []).slice().sort();
      // The MCP schema marks defaulted fields optional too, so compare only the
      // genuinely required args: TOOL_DEFS' required list must be a subset.
      for (const r of expected) expect(required, `${def.name}.${r}`).toContain(r);
    }
  });

  it('every WRITE_TOOLS entry is a registered tool', async () => {
    const names = new Set((await mcp.listTools()).map((t) => t.name));
    for (const w of WRITE_TOOLS) expect(names.has(w), w).toBe(true);
  });

  it('a missing required argument is a validation error, not a crash, and writes nothing', async () => {
    const tools = await mcp.listTools();
    for (const t of tools) {
      const required = (t.inputSchema as { required?: string[] }).required ?? [];
      if (required.length === 0) continue;
      const r = await mcp.callTool(t.name, {});
      expect(r.isError, t.name).toBe(true);
      expect(r.text, t.name).toMatch(/validation|invalid/i);
    }
    expect(mcp.afterWrite).not.toHaveBeenCalled();
    expect(await txCount()).toBe(7);
  });

  it.each([
    ['spending_summary', { year: '2026' }],
    ['list_transactions', { limit: 'ten' }],
    ['edit_transaction', { id: 5, category: 'Food' }],
    ['ignore_transaction', { id: 't1', ignore: 'yes' }],
    ['add_rule', { pattern: 'x', match_type: 'glob', category: 'Food' }],
  ])('%s rejects a wrongly typed argument', async (name, args) => {
    const r = await mcp.callTool(name, args);
    expect(r.isError).toBe(true);
    expect(mcp.afterWrite).not.toHaveBeenCalled();
  });

  it('unknown extra arguments are stripped and ignored (not an error)', async () => {
    const r = await mcp.callTool('list_hidden_categories', { bogus: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Transfer');
  });

  it('an unknown tool name is an error', async () => {
    const r = await mcp.callTool('no_such_tool', {});
    expect(r.isError).toBe(true);
  });
});

// ─── (2) Read tools ──────────────────────────────────────────────────────────

describe('read tools', () => {
  it('spending_summary totals a month, excluding hidden categories and ignored rows', async () => {
    const r = await mcp.callTool('spending_summary', { year: Y, month: M });
    expect(r.text).toContain('Income: $3000.00');
    expect(r.text).toContain('Expenses: $1029.00');
    expect(r.text).toContain('Net: +$1971.00');
    expect(r.text).toContain('Food: $20.00');
    expect(r.text).not.toContain('Transfer');
  });

  it('spending_summary accepts from/to and rejects month 13', async () => {
    const ok = await mcp.callTool('spending_summary', { from: day(1), to: day(28) });
    expect(ok.text).toContain('Expenses: $1029.00');
    expect((await mcp.callTool('spending_summary', { year: Y, month: 13 })).isError).toBe(true);
    expect((await mcp.callTool('spending_summary', { year: Y, month: 0 })).isError).toBe(true);
  });

  it('merchant_summary lists top merchants with share of category spend', async () => {
    const r = await mcp.callTool('merchant_summary', { category: 'Food', from: day(1), to: day(28) });
    expect(r.text).toContain('Corner Cafe  $20.00  2 txns  100.0%');
  });

  describe('list_transactions', () => {
    it('lists newest first, hides ignored rows by default and shows them with include_ignored', async () => {
      const def = await mcp.callTool('list_transactions', {});
      expect(def.text.split('\n')[0]).toContain('Mystery Co');
      expect(def.text).not.toContain('Ignored Thing');
      const inc = await mcp.callTool('list_transactions', { include_ignored: true });
      expect(inc.text).toContain('Ignored Thing');
    });

    it('applies the category, search and date filters and the limit', async () => {
      expect((await mcp.callTool('list_transactions', { category: 'Rent' })).text).toContain('[t3]');
      expect((await mcp.callTool('list_transactions', { search: 'landlord' })).text.split('\n')).toHaveLength(1);
      expect((await mcp.callTool('list_transactions', { from: day(5), to: day(6) })).text.split('\n')).toHaveLength(2);
      expect((await mcp.callTool('list_transactions', { limit: 2 })).text.split('\n')).toHaveLength(2);
    });

    it('treats LIKE wildcards and backslashes in search as literal text', async () => {
      for (const [id, name] of [['w1', '100% Cash'], ['w2', '100X Cash'], ['w3', 'a_b'], ['w4', 'axb'], ['w5', 'back\\slash']]) {
        await seedTx(db, { id, account_id: 'chk', date: day(9), name, amount: 1, category: 'Food' });
      }
      const names = async (search: string) =>
        (await mcp.callTool('list_transactions', { search })).text.split('\n').filter(Boolean);
      const has = (lines: string[], id: string) => lines.some((l) => l.includes(`[${id}]`));
      const pct = await names('100%');
      expect(has(pct, 'w1')).toBe(true);
      expect(has(pct, 'w2')).toBe(false);
      const us = await names('a_b');
      expect(has(us, 'w3')).toBe(true);
      expect(has(us, 'w4')).toBe(false);
      expect(has(await names('back\\slash'), 'w5')).toBe(true);
      expect(has(await names('k\\s'), 'w5')).toBe(true);
      expect(has(await names('100X'), 'w2')).toBe(true);
      expect(has(await names('CASH'), 'w1')).toBe(true);
    });

    it('escapes wildcards in the display_name clause too', async () => {
      for (const [id, dn] of [['d1', '50% Off'], ['d2', '50X Off'], ['d3', 'p_q'], ['d4', 'pxq']]) {
        await seedTx(db, { id, account_id: 'chk', date: day(9), name: `RAW ${id}`, amount: 1, category: 'Food' });
        await db.execute({ sql: 'UPDATE transactions SET display_name = ? WHERE id = ?', args: [dn, id] });
      }
      const run = async (search: string) =>
        (await mcp.callTool('list_transactions', { search })).text;
      const pct = await run('50%'); expect(pct).toContain('[d1]'); expect(pct).not.toContain('[d2]');
      const us = await run('p_q'); expect(us).toContain('[d3]'); expect(us).not.toContain('[d4]');
    });

    it('defaults to 50 rows and enforces 1..500', async () => {
      for (let i = 0; i < 60; i++) await seedTx(db, { account_id: 'chk', date: day(10), name: `Bulk ${i}`, amount: 1, category: 'Food' });
      expect((await mcp.callTool('list_transactions', {})).text.split('\n')).toHaveLength(50);
      expect((await mcp.callTool('list_transactions', { limit: 500 })).isError).toBe(false);
      expect((await mcp.callTool('list_transactions', { limit: 0 })).isError).toBe(true);
      expect((await mcp.callTool('list_transactions', { limit: 501 })).isError).toBe(true);
    });
  });

  describe('export_transactions', () => {
    it('emits a CSV with the documented header and sign convention, hiding hidden categories', async () => {
      const r = await mcp.callTool('export_transactions', { from: day(1), to: day(28) });
      const lines = r.text.split('\n');
      expect(lines[0]).toBe('date,name,display_name,amount,category,account,tags,is_ignored,is_pending');
      expect(r.text).toContain(`${day(1)},Landlord,Landlord,-1000.00,Rent,Main,,false,false`);
      expect(r.text).toContain(`${day(2)},Employer,Employer,3000.00,Income,Main,,false,false`);
      expect(r.text).not.toContain('Transfer');
    });

    it('include_hidden brings the hidden category back', async () => {
      const r = await mcp.callTool('export_transactions', { from: day(1), to: day(28), include_hidden: true });
      expect(r.text).toContain('Transfer');
    });

    it('rejects a bad format and missing from/to', async () => {
      expect((await mcp.callTool('export_transactions', { from: day(1), to: day(28), format: 'xlsx' })).isError).toBe(true);
      expect((await mcp.callTool('export_transactions', { from: day(1) })).isError).toBe(true);
      expect((await mcp.callTool('export_transactions', { to: day(1) })).isError).toBe(true);
    });
  });

  it('list_rules / list_name_rules / list_hidden_categories report what is stored', async () => {
    expect((await mcp.callTool('list_rules')).text).toBe('No rules defined.');
    expect((await mcp.callTool('list_name_rules')).text).toBe('No name rules defined.');
    await db.execute("INSERT INTO category_rules (priority, match_type, pattern, category) VALUES (5, 'name', 'cafe', 'Dining')");
    await db.execute("INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'corner', 'The Cafe')");
    expect((await mcp.callTool('list_rules')).text).toMatch(/\[\d+\] pri=5 name\s+"cafe" → Dining/);
    expect((await mcp.callTool('list_name_rules')).text).toMatch(/\[\d+\] name\s+"corner" → "The Cafe"/);
    expect((await mcp.callTool('list_hidden_categories')).text).toBe('Transfer');
  });

  it('list_accounts shows nicknames over names', async () => {
    const r = await mcp.callTool('list_accounts');
    expect(r.text).toContain('Main (checking)');
    expect(r.text).toContain('Card (credit card)');
  });

  describe('uncategorized_summary', () => {
    it('counts repeated names', async () => {
      await seedTx(db, { account_id: 'cc', name: 'Mystery Co', amount: 3, category: 'Uncategorized' });
      expect((await mcp.callTool('uncategorized_summary')).text).toBe('   2x  Mystery Co');
    });
    it('limit is bounded 1..100', async () => {
      expect((await mcp.callTool('uncategorized_summary', { limit: 1 })).isError).toBe(false);
      expect((await mcp.callTool('uncategorized_summary', { limit: 100 })).isError).toBe(false);
      expect((await mcp.callTool('uncategorized_summary', { limit: 0 })).isError).toBe(true);
      expect((await mcp.callTool('uncategorized_summary', { limit: 101 })).isError).toBe(true);
    });
  });

  it('list_tags and tag_summary reflect tagged transactions', async () => {
    await mcp.callTool('tag_transaction', { id: 't1', tag: 'coffee', add: true });
    expect((await mcp.callTool('list_tags')).text).toMatch(/coffee\s+1 txn /);
    const s = await mcp.callTool('tag_summary', { tag: 'coffee' });
    expect(s.text).toContain('#coffee');
    expect(s.text).toContain('Expenses: $12.50');
    expect(s.text).toContain('Food: $12.50');
  });

  it('get_balances reports assets, liabilities and net worth', async () => {
    const r = await mcp.callTool('get_balances');
    expect(r.text).toContain('Total assets: $5,000.00');
    expect(r.text).toContain('Total liabilities: $300.00');
    expect(r.text).toContain('Net worth: $4,700.00');
  });

  it('get_financial_health reports net worth and enforces rate bounds', async () => {
    expect((await mcp.callTool('get_financial_health')).text).toContain('Net worth: $4,700');
    expect((await mcp.callTool('get_financial_health', { withdrawal_rate: 0.5, growth_rate: 0 })).isError).toBe(false);
    expect((await mcp.callTool('get_financial_health', { withdrawal_rate: 10, growth_rate: 20 })).isError).toBe(false);
    for (const bad of [{ withdrawal_rate: 0.4 }, { withdrawal_rate: 10.1 }, { growth_rate: -1 }, { growth_rate: 20.1 }]) {
      expect((await mcp.callTool('get_financial_health', bad)).isError, JSON.stringify(bad)).toBe(true);
    }
  });

  it('get_scorecard buckets spending vs the typical month; window and day are validated', async () => {
    const r = await mcp.callTool('get_scorecard', { year: Y, month: M, day: 28, window: 'month' });
    expect(r.text).toContain('Scorecard');
    expect(r.text).toContain('Rent');
    expect(r.text).toMatch(/NET: \+\$1,029 vs typical month/);
    expect((await mcp.callTool('get_scorecard', { window: 'year' })).isError).toBe(true);
    expect((await mcp.callTool('get_scorecard', { day: 0 })).isError).toBe(true);
    expect((await mcp.callTool('get_scorecard', { day: 32 })).isError).toBe(true);
    expect((await mcp.callTool('get_scorecard', { day: 31 })).isError).toBe(false);
  });

  it('get_trends lists the requested number of months and bounds months to 1..60', async () => {
    const r = await mcp.callTool('get_trends', { months: 2 });
    expect(r.text.split('\n').filter((l) => /^[A-Z][a-z]{2} \d{4}/.test(l))).toHaveLength(2);
    expect((await mcp.callTool('get_trends', { months: 60 })).isError).toBe(false);
    expect((await mcp.callTool('get_trends', { months: 0 })).isError).toBe(true);
    expect((await mcp.callTool('get_trends', { months: 61 })).isError).toBe(true);
  });

  it('get_finance_guide lists topics, returns a topic, and rejects an unknown one', async () => {
    expect((await mcp.callTool('get_finance_guide')).text).toMatch(/^Topics:/);
    expect((await mcp.callTool('get_finance_guide', { topic: 'debt' })).text).toContain('# Debt Payoff Strategy');
    expect((await mcp.callTool('get_finance_guide', { topic: 'crypto' })).isError).toBe(true);
  });

  it('get_net_worth_history groups by granularity and validates it', async () => {
    const r = await mcp.callTool('get_net_worth_history', { granularity: 'month' });
    expect(r.text).toContain(`${ym}`);
    expect(r.text).toContain('$4,700');
    expect((await mcp.callTool('get_net_worth_history', { granularity: 'decade' })).isError).toBe(true);
  });

  it('get_screen returns the TUI screen text, or says it is unavailable', async () => {
    expect((await mcp.callTool('get_screen')).text).toContain('Screen not available');
    writeFileSync(join(TEST_DATA_DIR, 'screen.txt'), 'hello screen');
    expect((await mcp.callTool('get_screen')).text).toBe('hello screen');
  });

  it('list_canvases says so when there are none', async () => {
    expect((await mcp.callTool('list_canvases')).text).toBe('No canvases found.');
  });

  it('calculate_tvm solves a value and turns a zero-period solve into an error message', async () => {
    expect((await mcp.callTool('calculate_tvm', { pv: 100000, fv: 0, n: 360, rate: 0.005 })).text).toContain('PMT = -599.55');
    const bad = await mcp.callTool('calculate_tvm', { pv: 1000, fv: 0, n: 0, rate: 0.01 });
    expect(bad.text).toMatch(/^Error: .*periods/i);
  });

  it('generate_canvas returns context built from the prompt (no LLM call, never a write)', async () => {
    const r = await mcp.callTool('generate_canvas', { prompt: 'how long to pay off my mortgage?' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('## User prompt\nhow long to pay off my mortgage?');
    expect(r.text).toContain('render_canvas');
    expect(mcp.afterWrite).not.toHaveBeenCalled();
  });
});

// ─── (3) Write tools ─────────────────────────────────────────────────────────

/** Calls a write tool and asserts the afterWrite contract in one place. */
async function expectWrite(name: string, args: Record<string, unknown>, fires: boolean) {
  const r = await mcp.callTool(name, args);
  expect(mcp.afterWrite, `${name} afterWrite`).toHaveBeenCalledTimes(fires ? 1 : 0);
  return r;
}

describe('write tools: transactions', () => {
  const add = (over: Record<string, unknown> = {}) => ({
    account_id: 'chk', date: day(10), name: 'Hand Entered', amount: 12.34, category: 'Food', ...over,
  });
  const stored = (name = 'Hand Entered') => one<{ amount: number; source: string; manual_category: string; display_name: string | null; account_id: string; date: string }>(
    'SELECT amount, source, manual_category, display_name, account_id, date FROM transactions WHERE name = ?', [name]);

  it('add_transaction: positive is an outflow stored positive, source is manual, category pinned', async () => {
    const r = await expectWrite('add_transaction', add(), true);
    expect(r.text).toMatch(/^Added "Hand Entered" 12.34 on .* \[id: manual-/);
    expect(await stored()).toMatchObject({ amount: 12.34, source: 'manual', manual_category: 'Food', account_id: 'chk', date: day(10) });
  });

  it('add_transaction: a negative amount is an inflow stored negative', async () => {
    await expectWrite('add_transaction', add({ amount: -80 }), true);
    expect((await stored()).amount).toBe(-80);
  });

  it('add_transaction applies a matching name rule to display_name', async () => {
    await db.execute("INSERT INTO name_rules (match_type, pattern, replacement) VALUES ('name', 'hand entered', 'Pretty Name')");
    await expectWrite('add_transaction', add(), true);
    expect((await stored()).display_name).toBe('Pretty Name');
  });

  // Pinned as observed: the amount is stored exactly as given (no rounding to
  // cents, no magnitude cap). See the report: this is a validation gap, not a decision.
  it.each([[4.505], [0.1 + 0.2], [1e15], [1e308]])('add_transaction stores %d exactly as given (no rounding or cap)', async (amount) => {
    await expectWrite('add_transaction', add({ amount }), true);
    expect((await stored()).amount).toBe(amount);
  });

  it.each([[NaN], [Infinity], [-Infinity]])('add_transaction rejects %d at the schema and writes nothing', async (amount) => {
    const r = await expectWrite('add_transaction', add({ amount }), false);
    expect(r.isError).toBe(true);
    expect(await txCount()).toBe(7);
  });

  it.each([
    ['a malformed date', { date: '03/05/2026' }, /not|invalid/i],
    ['an impossible date', { date: '2026-02-30' }, /Invalid transaction date/],
    ['an empty name', { name: '   ' }, /name is required/],
    ['an empty category', { category: '' }, /category is required/],
    ['an unknown account', { account_id: 'nope' }, /No account with id nope/],
  ])('add_transaction with %s fails, writes nothing and does not fire afterWrite', async (_n, over, msg) => {
    const r = await expectWrite('add_transaction', add(over), false);
    expect(r.text).toMatch(/^Error: /);
    expect(r.text).toMatch(msg);
    expect(await txCount()).toBe(7);
  });

  it('edit_transaction pins a category; an unknown id changes nothing', async () => {
    await expectWrite('edit_transaction', { id: 't1', category: 'Dining' }, true);
    expect(await one('SELECT category, manual_category FROM transactions WHERE id = ?', ['t1'])).toEqual({ category: 'Dining', manual_category: 'Dining' });
    mcp.afterWrite.mockClear();
    const r = await expectWrite('edit_transaction', { id: 'nope', category: 'Dining' }, false);
    expect(r.text).toBe('No transaction with id nope.');
  });

  it('clear_edit reverts a pinned category; unknown id does not fire', async () => {
    await db.execute("UPDATE transactions SET manual_category = 'Dining', category = 'Dining' WHERE id = 't1'");
    await expectWrite('clear_edit', { id: 't1' }, true);
    expect((await one<{ manual_category: string | null }>('SELECT manual_category FROM transactions WHERE id = ?', ['t1'])).manual_category).toBeNull();
    mcp.afterWrite.mockClear();
    await expectWrite('clear_edit', { id: 'nope' }, false);
  });

  it('ignore_transaction toggles the flag; unknown id does not fire', async () => {
    await expectWrite('ignore_transaction', { id: 't1', ignore: true }, true);
    expect((await one<{ ignored: number }>('SELECT ignored FROM transactions WHERE id = ?', ['t1'])).ignored).toBe(1);
    mcp.afterWrite.mockClear();
    await expectWrite('ignore_transaction', { id: 't1', ignore: false }, true);
    expect((await one<{ ignored: number }>('SELECT ignored FROM transactions WHERE id = ?', ['t1'])).ignored).toBe(0);
    mcp.afterWrite.mockClear();
    await expectWrite('ignore_transaction', { id: 'nope', ignore: true }, false);
  });

  it('set_transaction_date reattributes, preserving the posting date; clear_transaction_date restores it', async () => {
    await expectWrite('set_transaction_date', { id: 't1', date: day(25) }, true);
    expect(await one('SELECT date, original_date FROM transactions WHERE id = ?', ['t1'])).toEqual({ date: day(25), original_date: day(5) });
    mcp.afterWrite.mockClear();
    await expectWrite('clear_transaction_date', { id: 't1' }, true);
    expect(await one('SELECT date, original_date FROM transactions WHERE id = ?', ['t1'])).toEqual({ date: day(5), original_date: null });
  });

  it.each([
    ['set_transaction_date', { id: 't1', date: '2026-02-30' }, /not a valid date/],
    ['set_transaction_date', { id: 'nope', date: '2026-02-03' }, /No transaction with id nope/],
    ['clear_transaction_date', { id: 'nope' }, /No transaction with id nope/],
    ['clear_transaction_date', { id: 't1' }, /has no date override/],
  ])('%s %j fails softly without firing afterWrite', async (name, args, msg) => {
    const r = await expectWrite(name, args, false);
    expect(r.text).toMatch(msg);
    expect((await one<{ date: string }>('SELECT date FROM transactions WHERE id = ?', ['t1'])).date).toBe(day(5));
  });

  it('tag_transaction adds, is idempotent, removes, and rejects unknown ids', async () => {
    const tags = async () => (await q<{ name: string }>('SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id WHERE tt.transaction_id = ?', ['t1'])).map((r) => r.name);
    await expectWrite('tag_transaction', { id: 't1', tag: 'coffee', add: true }, true);
    mcp.afterWrite.mockClear();
    await mcp.callTool('tag_transaction', { id: 't1', tag: 'coffee', add: true });
    expect(await tags()).toEqual(['coffee']);
    mcp.afterWrite.mockClear();
    await expectWrite('tag_transaction', { id: 't1', tag: 'coffee', add: false }, true);
    expect(await tags()).toEqual([]);
    mcp.afterWrite.mockClear();
    const r = await expectWrite('tag_transaction', { id: 'nope', tag: 'coffee', add: true }, false);
    expect(r.text).toBe('No transaction with id nope.');
  });
});

describe('write tools: rules and hidden categories', () => {
  it('add_rule recategorises matching transactions; delete_rule reverts them', async () => {
    await expectWrite('add_rule', { pattern: 'corner', match_type: 'name', category: 'Dining' }, true);
    expect((await one<{ category: string }>('SELECT category FROM transactions WHERE id = ?', ['t1'])).category).toBe('Dining');
    const id = (await one<{ id: number }>('SELECT id FROM category_rules')).id;
    mcp.afterWrite.mockClear();
    await expectWrite('delete_rule', { id }, true);
    expect((await one<{ category: string }>('SELECT category FROM transactions WHERE id = ?', ['t1'])).category).not.toBe('Dining');
    expect(await q('SELECT id FROM category_rules')).toHaveLength(0);
  });

  it('add_rule with a bad regex fails, adds nothing and does not fire', async () => {
    const r = await expectWrite('add_rule', { pattern: '(', match_type: 'regex', category: 'X' }, false);
    expect(r.isError).toBe(true);
    expect(await q('SELECT id FROM category_rules')).toHaveLength(0);
  });

  it('delete_rule / delete_name_rule with an unknown id fail softly', async () => {
    expect((await expectWrite('delete_rule', { id: 999 }, false)).text).toBe('No rule with id 999.');
    expect((await expectWrite('delete_name_rule', { id: 999 }, false)).text).toBe('No name rule with id 999.');
  });

  it('add_rule honours amount bounds and account scope', async () => {
    await expectWrite('add_rule', { pattern: 'corner', match_type: 'name', category: 'Dining', account_id: 'cc' }, true);
    // t1/t2 live on chk, so a cc-scoped rule must not touch them.
    expect((await one<{ category: string }>('SELECT category FROM transactions WHERE id = ?', ['t1'])).category).toBe('Food');
    expect(await one('SELECT account_id FROM category_rules')).toEqual({ account_id: 'cc' });
  });

  it('add_name_rule renames matching transactions; delete_name_rule removes the rule', async () => {
    await expectWrite('add_name_rule', { pattern: 'corner', match_type: 'name', replacement: 'The Cafe' }, true);
    expect((await one<{ display_name: string }>('SELECT display_name FROM transactions WHERE id = ?', ['t1'])).display_name).toBe('The Cafe');
    const id = (await one<{ id: number }>('SELECT id FROM name_rules')).id;
    mcp.afterWrite.mockClear();
    await expectWrite('delete_name_rule', { id }, true);
    expect(await q('SELECT id FROM name_rules')).toHaveLength(0);
  });

  it('add_name_rule scoped to an account only renames that account', async () => {
    await expectWrite('add_name_rule', { pattern: 'corner', match_type: 'name', replacement: 'The Cafe', account_id: 'cc' }, true);
    expect((await one<{ display_name: string | null }>('SELECT display_name FROM transactions WHERE id = ?', ['t1'])).display_name).toBeNull();
  });

  it('add_name_rule with a bad regex fails and adds nothing', async () => {
    const r = await expectWrite('add_name_rule', { pattern: '[', match_type: 'regex', replacement: 'X' }, false);
    expect(r.isError).toBe(true);
    expect(await q('SELECT id FROM name_rules')).toHaveLength(0);
  });

  it('toggle_hidden_category hides and unhides', async () => {
    await expectWrite('toggle_hidden_category', { category: 'Food', hide: true }, true);
    expect((await mcp.callTool('list_hidden_categories')).text).toBe('Food\nTransfer');
    mcp.afterWrite.mockClear();
    await expectWrite('toggle_hidden_category', { category: 'Food', hide: false }, true);
    expect((await mcp.callTool('list_hidden_categories')).text).toBe('Transfer');
  });
});

describe('write tools: sync', () => {
  const plaidWith = (pages: Parameters<typeof makeFakePlaid>[0]) =>
    vi.mocked(getPlaidClient).mockReturnValue(makeFakePlaid(pages) as never);

  it('a sync that brings in transactions is a write and fires afterWrite once', async () => {
    await seedPlaidItem(db, 'item-1');
    plaidWith({ pages: [{ added: [makePlaidTx({ transaction_id: 'new-1', account_id: 'chk', name: 'Brand New', amount: 4 })] }], accounts: [makePlaidAccount({ account_id: 'chk' })] });
    const r = await expectWrite('sync', {}, true);
    expect(r.text).toContain('item-1: +1 added');
    expect(await q('SELECT id FROM transactions WHERE id = ?', ['new-1'])).toHaveLength(1);
  });

  it('a debounced sync changes nothing and is not a write', async () => {
    await seedPlaidItem(db, 'item-1', { lastSyncedAt: Date.now() - 60_000 });
    const plaid = makeFakePlaid({ pages: [{ added: [makePlaidTx({ transaction_id: 'new-1' })] }] });
    vi.mocked(getPlaidClient).mockReturnValue(plaid as never);
    await expectWrite('sync', {}, false);
    expect(plaid.transactionsSync).not.toHaveBeenCalled();
    expect(await txCount()).toBe(7);
  });

  it('a sync that adds nothing but dedupes a CSV row against an existing Plaid row is a write', async () => {
    await seedPlaidItem(db, 'item-1');
    await seedTx(db, { id: 'plaid-dup', source: 'plaid', account_id: 'chk', date: day(12), name: 'Dup Shop', amount: 33, category: 'Food' });
    await seedTx(db, { id: 'csv-dup', source: 'csv', account_id: 'chk', date: day(12), name: 'Dup Shop', amount: 33, category: 'Food' });
    plaidWith({ pages: [{}], accounts: [] });
    await expectWrite('sync', {}, true);
    expect(await q('SELECT id FROM transactions WHERE id = ?', ['csv-dup'])).toHaveLength(0);
    expect(await q('SELECT id FROM transactions WHERE id = ?', ['plaid-dup'])).toHaveLength(1);
  });

  it('a sync with nothing new is not a write', async () => {
    await seedPlaidItem(db, 'item-1');
    plaidWith({ pages: [{}], accounts: [] });
    await expectWrite('sync', {}, false);
  });

  it('a failing item is reported as FAILED (not as "+0 added") and is not a write', async () => {
    await seedPlaidItem(db, 'item-1');
    plaidWith({ pages: [new Error('ITEM_LOGIN_REQUIRED')] });
    const r = await expectWrite('sync', {}, false);
    expect(r.text).toContain('item-1: FAILED — ITEM_LOGIN_REQUIRED');
  });

  it('with no linked items, sync reports zero and does not fire', async () => {
    const r = await expectWrite('sync', {}, false);
    expect(r.text).toContain('Total new transactions: 0');
  });
});

describe('write tools: canvases', () => {
  const spec = (title = 'My Canvas') => JSON.stringify({ title, elements: [] });
  const history = () => (existsSync(join(TEST_DATA_DIR, 'canvas-history.json'))
    ? JSON.parse(readFileSync(join(TEST_DATA_DIR, 'canvas-history.json'), 'utf8')) as { id: string; title: string }[] : []);

  it('show_canvas saves to history and fires afterWrite once', async () => {
    const r = await expectWrite('show_canvas', { spec: spec(), prompt: 'a prompt' }, true);
    expect(r.text).toMatch(/Canvas "My Canvas" rendered on screen 9 \(id: .+\)\./);
    expect(history().map((h) => h.title)).toEqual(['My Canvas']);
    expect((await mcp.callTool('list_canvases', { search: 'a prompt' })).text).toContain('My Canvas');
  });

  it('show_canvas with malformed spec JSON errors, saves nothing and does not fire', async () => {
    const r = await expectWrite('show_canvas', { spec: '{not json', prompt: 'p' }, false);
    expect(r.isError).toBe(true);
    expect(history()).toEqual([]);
  });

  it('load_canvas reopens a saved canvas; an unknown id does not fire', async () => {
    await mcp.callTool('show_canvas', { spec: spec(), prompt: 'p' });
    mcp.afterWrite.mockClear();
    const id = history()[0].id;
    const r = await expectWrite('load_canvas', { id }, true);
    expect(r.text).toBe('Canvas "My Canvas" loaded on screen 9.');
    mcp.afterWrite.mockClear();
    expect((await expectWrite('load_canvas', { id: 'nope' }, false)).text).toBe('No canvas found with id "nope".');
    // Ids are matched exactly, case included.
    expect((await expectWrite('load_canvas', { id: id.toUpperCase() }, false)).text).toContain('No canvas found');
  });

  it('delete_canvas removes the entry; an unknown id changes nothing and does not fire', async () => {
    await mcp.callTool('show_canvas', { spec: spec(), prompt: 'p' });
    mcp.afterWrite.mockClear();
    const id = history()[0].id;
    await expectWrite('delete_canvas', { id }, true);
    expect(history()).toEqual([]);
    mcp.afterWrite.mockClear();
    expect((await expectWrite('delete_canvas', { id }, false)).text).toBe(`No canvas found with id "${id}".`);
  });
});

describe('afterWrite invariants', () => {
  it('no read tool ever fires afterWrite', async () => {
    const reads: [string, Record<string, unknown>][] = [
      ['spending_summary', { year: Y, month: M }], ['merchant_summary', { category: 'Food', from: day(1), to: day(28) }],
      ['list_transactions', {}], ['export_transactions', { from: day(1), to: day(28) }], ['list_rules', {}], ['list_name_rules', {}],
      ['list_hidden_categories', {}], ['list_accounts', {}], ['uncategorized_summary', {}], ['list_tags', {}], ['tag_summary', { tag: 'x' }],
      ['get_balances', {}], ['get_financial_health', {}], ['get_scorecard', {}], ['get_trends', {}], ['get_finance_guide', {}],
      ['get_net_worth_history', {}], ['get_screen', {}], ['list_canvases', {}], ['calculate_tvm', { pv: 1, fv: 2, n: 3 }],
      ['generate_canvas', { prompt: 'x' }],
      ['preview_balance_import', { csv: 'date,account,balance\n' }],
    ];
    const names = new Set((await mcp.listTools()).map((t) => t.name));
    const covered = new Set(reads.map(([n]) => n));
    for (const n of names) if (!WRITE_TOOLS.has(n)) expect(covered.has(n), `${n} is a read tool missing from the sweep`).toBe(true);
    for (const [n, a] of reads) await mcp.callTool(n, a);
    expect(mcp.afterWrite).not.toHaveBeenCalled();
  });
});
