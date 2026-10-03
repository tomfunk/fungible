import { describe, it, expect, vi } from 'vitest';

// makeMcpClient loads core/tools.ts, which opens core/db.js at import: mock it so
// nothing touches the real ~/.fungible database.
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('./makeTestDb.js');
  return { db: await makeTestDb() };
});

import { makeTestDb } from './makeTestDb.js';
import { makeMcpClient } from './makeMcpClient.js';
import { seedSecrets } from './seedSecrets.js';

describe('makeMcpClient / seedSecrets', () => {
  it('lists tools, calls one, reports validation errors and closes twice safely', async () => {
    const mcp = await makeMcpClient();
    const names = (await mcp.listTools()).map((t) => t.name);
    expect(names).toContain('calculate_tvm');
    const ok = await mcp.callTool('calculate_tvm', { pv: 100000, fv: 0, n: 360, rate: 0.005 });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('-599.55');
    const bad = await mcp.callTool('calculate_tvm', { pv: 'x' });
    expect(bad.isError).toBe(true);
    expect(mcp.afterWrite).not.toHaveBeenCalled();
    await mcp.close();
    await mcp.close();
  });

  it('seedSecrets plants secrets, detects leaks and restores env', async () => {
    const db = await makeTestDb();
    const before = process.env.OPENAI_API_KEY;
    const s = await seedSecrets(db);
    expect(process.env.OPENAI_API_KEY).toContain('SECRET-DO-NOT-LEAK');
    expect((await db.execute('SELECT COUNT(*) c FROM plaid_items')).rows[0].c).toBe(2);
    expect(s.leaks('nothing here')).toEqual([]);
    expect(s.leaks(`oops ${s.secrets[0]}`)).toEqual([s.secrets[0]]);
    s.restore();
    expect(process.env.OPENAI_API_KEY).toBe(before);
  });
});
