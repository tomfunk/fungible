import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { makeTestDb } from './makeTestDb.js';

/**
 * Guards against the in-memory test schema drifting from the real one: a
 * fixture column or CHECK that production lacks lets tests pass on a schema
 * nobody ships. Real schema = fresh initDb() on a temp data dir.
 */
type Col = { name: string; type: string; notnull: number; pk: number };

let real: Client;
let fake: Client;
let dir: string;

async function tables(c: Client): Promise<string[]> {
  const r = await c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return r.rows.map((x) => String(x.name));
}
async function cols(c: Client, t: string): Promise<Col[]> {
  const r = await c.execute(`PRAGMA table_info(${t})`);
  return r.rows.map((x) => ({ name: String(x.name), type: String(x.type).toUpperCase(), notnull: Number(x.notnull), pk: Number(x.pk) }));
}
async function sqlOf(c: Client, t: string): Promise<string> {
  const r = await c.execute({ sql: 'SELECT sql FROM sqlite_master WHERE name = ?', args: [t] });
  return String(r.rows[0]?.sql ?? '');
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-drift-'));
  process.env.FUNGIBLE_DATA_DIR = dir;
  const mod = await import('../../core/db.js');
  await mod.initDb();
  real = mod.db;
  fake = await makeTestDb();
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.FUNGIBLE_DATA_DIR;
});

describe('makeTestDb schema vs initDb', () => {
  it('only defines tables that exist in the real schema', async () => {
    const realTables = new Set(await tables(real));
    const extra = (await tables(fake)).filter((t) => !realTables.has(t));
    expect(extra).toEqual([]);
  });

  it('has the same columns, types and nullability for every table it defines', async () => {
    const diffs: string[] = [];
    for (const t of await tables(fake)) {
      const f = await cols(fake, t);
      const r = await cols(real, t);
      const key = (c: Col) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`;
      const fs_ = new Set(f.map(key));
      const rs = new Set(r.map(key));
      for (const k of fs_) if (!rs.has(k)) diffs.push(`${t}: fixture-only ${k}`);
      for (const k of rs) if (!fs_.has(k)) diffs.push(`${t}: real-only ${k}`);
    }
    expect(diffs).toEqual([]);
  });

  it('has the same CHECK constraints (transactions.source, categories.flexibility)', async () => {
    const norm = (s: string) => [...s.matchAll(/CHECK\s*\(([^)]*\([^)]*\)[^)]*|[^)]*)\)/gi)].map((m) => m[1].replace(/\s+/g, '').toLowerCase()).sort();
    for (const t of await tables(fake)) {
      expect({ t, checks: norm(await sqlOf(fake, t)) }).toEqual({ t, checks: norm(await sqlOf(real, t)) });
    }
  });
});
