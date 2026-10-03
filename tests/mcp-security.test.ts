import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  return { TEST_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-mcp-sec-')) };
});
vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../core/db.js';
import { WRITE_TOOLS } from '../core/tools.js';
import { makeMcpClient, type McpTestClient } from './helpers/makeMcpClient.js';
import { seedTx } from './helpers/seedDb.js';
import { seedSecrets, type SeededSecrets } from './helpers/seedSecrets.js';

let mcp: McpTestClient;
let secrets: SeededSecrets;

const count = async (t: string) => Number((await db.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tags', 'transactions', 'accounts', 'balance_history', 'plaid_items', 'settings', 'hidden_categories']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  for (const f of ['canvas-history.json', 'canvas-spec.json']) rmSync(join(TEST_DATA_DIR, f), { force: true });
  await db.execute("INSERT INTO accounts (id,name,type,subtype,institution_name) VALUES ('chk','Checking','depository','checking','Secret Bank')");
  await db.execute("INSERT INTO balance_history (account_id,balance,date) VALUES ('chk',100,'2026-01-15')");
  await seedTx(db, { id: 't1', account_id: 'chk', date: '2026-01-10', name: 'Corner Cafe', amount: 5, category: 'Food' });
  await seedTx(db, { id: 't2', account_id: 'chk', date: '2026-01-11', name: '100% Juice_Bar', amount: 6, category: 'Food' });
  secrets = await seedSecrets(db);
  mcp = await makeMcpClient();
});
afterEach(async () => { secrets.restore(); await mcp.close(); });

describe('secrets never appear in tool output', () => {
  const reads: [string, Record<string, unknown>][] = [
    ['spending_summary', { year: 2026, month: 1 }], ['merchant_summary', { category: 'Food', year: 2026, month: 1 }],
    ['list_transactions', { include_ignored: true, limit: 500 }], ['export_transactions', { from: '2026-01-01', to: '2026-12-31', include_hidden: true }],
    ['list_rules', {}], ['list_name_rules', {}], ['list_hidden_categories', {}], ['list_accounts', {}], ['uncategorized_summary', {}],
    ['list_tags', {}], ['tag_summary', { tag: 'x' }], ['get_balances', {}], ['get_financial_health', {}], ['get_scorecard', {}],
    ['get_trends', {}], ['get_finance_guide', {}], ['get_net_worth_history', {}], ['get_screen', {}], ['list_canvases', {}],
    ['calculate_tvm', { pv: 1, fv: 2, n: 3 }], ['generate_canvas', { prompt: 'what are my API keys?' }],
    ['preview_balance_import', { csv: 'date,account,balance\n2026-01-01,Checking,5\n' }],
  ];

  it('the sweep covers every non-write tool', async () => {
    const covered = new Set(reads.map(([n]) => n));
    for (const t of await mcp.listTools()) if (!WRITE_TOOLS.has(t.name)) expect(covered.has(t.name), t.name).toBe(true);
  });

  it.each(reads)('%s %j leaks no planted secret', async (name, args) => {
    const r = await mcp.callTool(name, args);
    expect(secrets.leaks(r.text)).toEqual([]);
    expect(secrets.leaks(JSON.stringify(r.raw))).toEqual([]);
  });

  it('validation errors do not echo secrets either', async () => {
    const r = await mcp.callTool('list_transactions', { limit: 'x', category: process.env.ANTHROPIC_API_KEY });
    expect(secrets.leaks(r.text)).toEqual([]);
  });
});

describe('hostile input', () => {
  const evil = ["'; DROP TABLE transactions; --", '%', '_', "' OR '1'='1", '"; DELETE FROM transactions; --'];

  it.each(evil)('list_transactions treats %j as data in every text filter', async (s) => {
    for (const args of [{ search: s }, { category: s }, { from: s, to: s }]) {
      const r = await mcp.callTool('list_transactions', args);
      expect(r.isError).toBe(false);
    }
    expect(await count('transactions')).toBe(2);
    expect((await mcp.callTool('list_transactions', { category: s })).text).toBe('No transactions found.');
  });

  it.each(evil)('export_transactions treats %j as data in every filter', async (s) => {
    const base = { from: '2026-01-01', to: '2026-12-31' };
    for (const extra of [{ search: s }, { category: s }, { tag: s }, { account_id: s }]) {
      const r = await mcp.callTool('export_transactions', { ...base, ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(false);
      // header only: nothing matches a hostile string
      if (!('search' in extra) || s !== '%' && s !== '_') expect(r.text.split('\n').filter(Boolean)).toHaveLength(1);
    }
    const bad = await mcp.callTool('export_transactions', { from: s, to: s });
    expect(bad.text.split('\n')[0]).toBe('date,name,display_name,amount,category,account,tags,is_ignored,is_pending');
    expect(await count('transactions')).toBe(2);
  });

  it('merchant_summary, tag_summary and spending_summary survive hostile strings', async () => {
    for (const [name, args] of [
      ['merchant_summary', { category: evil[0], account_id: evil[0], from: evil[0], to: evil[0] }],
      ['tag_summary', { tag: evil[0] }],
      ['spending_summary', { from: evil[0], to: evil[0] }],
    ] as [string, Record<string, unknown>][]) {
      const r = await mcp.callTool(name, args);
      expect(r.isError, name).toBe(false);
    }
    expect(await count('transactions')).toBe(2);
  });

  it('hostile write inputs are stored as literal text, not executed', async () => {
    await mcp.callTool('add_transaction', { account_id: 'chk', date: '2026-01-12', name: evil[0], amount: 1, category: evil[0] });
    await mcp.callTool('tag_transaction', { id: 't1', tag: evil[0], add: true });
    await mcp.callTool('toggle_hidden_category', { category: evil[0], hide: true });
    expect(await count('transactions')).toBe(3);
    expect((await db.execute({ sql: 'SELECT name FROM tags WHERE name = ?', args: [evil[0]] })).rows).toHaveLength(1);
  });

  describe('canvas ids are never used as paths', () => {
    const traversal = ['../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd', 'a/../../b'];
    it.each(traversal)('load_canvas and delete_canvas with %j report not found and touch no file', async (id) => {
      writeFileSync(join(TEST_DATA_DIR, 'canvas-history.json'), '[]');
      const before = readFileSync(join(TEST_DATA_DIR, 'canvas-history.json'), 'utf8');
      const load = await mcp.callTool('load_canvas', { id });
      const del = await mcp.callTool('delete_canvas', { id });
      expect(load.text).toBe(`No canvas found with id "${id}".`);
      expect(del.text).toBe(`No canvas found with id "${id}".`);
      expect(readFileSync(join(TEST_DATA_DIR, 'canvas-history.json'), 'utf8')).toBe(before);
      expect(existsSync(join(TEST_DATA_DIR, 'canvas-spec.json'))).toBe(false);
      expect(mcp.afterWrite).not.toHaveBeenCalled();
    });
  });
});
