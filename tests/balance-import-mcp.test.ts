import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { db } from '../core/db.js';
import { makeMcpClient, type McpTestClient } from './helpers/makeMcpClient.js';

const csv = 'date,account,balance\n2026-01-01,Checking,100\n2026-01-02,Nowhere,5\n';
let mcp: McpTestClient;
let client: Client;
let afterWrite: McpTestClient['afterWrite'];

async function count() {
  return Number((await db.execute('SELECT COUNT(*) c FROM balance_history')).rows[0].c);
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

beforeEach(async () => {
  await db.execute('DELETE FROM accounts');
  await db.execute('DELETE FROM balance_history');
  await db.execute({ sql: 'INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)', args: ['chk', 'Checking', 'depository'] });
  await db.execute({ sql: 'INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)', args: ['chk', 5000, '2026-05-20'] });
  mcp = await makeMcpClient();
  client = mcp.client;
  afterWrite = mcp.afterWrite;
});

afterEach(() => mcp.close());

describe('balance import over MCP', () => {
  it('lists both tools with csv required and account_map/today optional', async () => {
    const { tools } = await client.listTools();
    for (const name of ['preview_balance_import', 'import_balance_history']) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      const schema = t!.inputSchema as { properties: Record<string, { type?: unknown }>; required?: string[] };
      expect(Object.keys(schema.properties).sort()).toEqual(['account_map', 'csv', 'today']);
      expect(schema.required).toEqual(['csv']);
      expect(schema.properties.csv.type).toBe('string');
    }
  });

  it('preview writes nothing and does not fire afterWrite', async () => {
    const r = await client.callTool({ name: 'preview_balance_import', arguments: { csv, today: '2026-06-01' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('no changes made');
    expect(text(r)).toContain('Unmatched account "Nowhere"');
    expect(await count()).toBe(1);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('import writes rows and fires afterWrite', async () => {
    const r = await client.callTool({ name: 'import_balance_history', arguments: { csv, today: '2026-06-01' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('1 new, 0 overwritten, 1 skipped');
    expect(await count()).toBe(2);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('honors account_map (including null to skip) through the server', async () => {
    const r = await client.callTool({
      name: 'import_balance_history',
      arguments: { csv: 'date,account,balance\n2026-01-01,Old Bank,7\n2026-01-01,Junk,9\n', today: '2026-06-01', account_map: { 'old bank': 'chk', junk: null } },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('1 new, 0 overwritten, 1 skipped');
    expect(text(r)).toContain('across 1 account');
    expect(await count()).toBe(2);
    const rows = (await db.execute("SELECT account_id, balance, date FROM balance_history WHERE date = '2026-01-01'")).rows;
    expect(rows.map((x) => [x.account_id, Number(x.balance)])).toEqual([['chk', 7]]);
  });

  it('a mid-batch failure returns an error text and does not fire afterWrite', async () => {
    await db.execute(`CREATE TRIGGER boom3 BEFORE INSERT ON balance_history WHEN NEW.balance = 666 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      const r = await client.callTool({
        name: 'import_balance_history',
        arguments: { csv: 'date,account,balance\n2026-01-01,Checking,1\n2026-01-02,Checking,666\n', today: '2026-06-01' },
      });
      expect(text(r)).toMatch(/^Import failed, nothing was written/);
      expect(afterWrite).not.toHaveBeenCalled();
      expect(await count()).toBe(1);
    } finally {
      await db.execute('DROP TRIGGER boom3');
    }
  });

  it('an import that skips every row does not fire afterWrite', async () => {
    const r = await client.callTool({ name: 'import_balance_history', arguments: { csv: 'date,account,balance\n2026-01-01,Nowhere,5\n', today: '2026-06-01' } });
    expect(text(r)).toContain('0 new, 0 overwritten, 1 skipped');
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('surfaces the too-large message', async () => {
    const big = 'date,account,balance\n' + 'x'.repeat(5 * 1024 * 1024);
    const r = await client.callTool({ name: 'import_balance_history', arguments: { csv: big } });
    expect(text(r)).toMatch(/too large/);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it.each(['preview_balance_import', 'import_balance_history'])('%s with missing csv is a validation error, not a crash', async (name) => {
    const r = await client.callTool({ name, arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/csv|invalid/i);
    expect(await count()).toBe(1);
    expect(afterWrite).not.toHaveBeenCalled();
    // server still alive
    const ok = await client.callTool({ name: 'preview_balance_import', arguments: { csv } });
    expect(ok.isError).toBeFalsy();
  });

  it('rejects wrongly typed input', async () => {
    const r = await client.callTool({ name: 'import_balance_history', arguments: { csv: 5 } });
    expect(r.isError).toBe(true);
    expect(await count()).toBe(1);
  });
});
