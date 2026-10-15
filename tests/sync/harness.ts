/**
 * Shared setup for the operation-log sync tests. A "device" is a temp data
 * dir with a file-backed DB carrying the test schema; several devices of one
 * user share a FakeServer. Test files mock core/db.js with a Proxy over
 * `current.client` (see header of tests/sync/oplog.test.ts) so product code
 * that imports the shared `db` writes to whichever device is current.
 */
import fs from 'node:fs';
import type { Client } from '@libsql/client';
import { makeTempDataDir, openTempDb, type TempDataDir } from '../helpers/tempFileDb.js';
import { configureAuth, memoryAuthAdapter } from '../../core/auth-client.js';
import { configureSync } from '../../core/sync-client.js';
import { FakeServer, fakeJwt } from './fakeServer.js';

export interface Device {
  dir: string;
  dbPath: string;
  client: Client;
  tmp: TempDataDir;
  close(): void;
}

export async function makeDevice(prefix = 'fungible-sync-'): Promise<Device> {
  const tmp = makeTempDataDir(prefix);
  const client = await openTempDb(tmp.dbPath);
  return {
    dir: tmp.dir, dbPath: tmp.dbPath, client, tmp,
    close() { try { client.close(); } catch { /* */ } tmp.cleanup(); },
  };
}

/** Point the auth client and engine at `server`, signed in as `user`. */
export function connect(server: FakeServer, user: string): void {
  configureAuth(memoryAuthAdapter({ access: fakeJwt(user), refresh: 'r' }), 'http://sync.test', { fetch: server.fetch });
  configureSync('http://sync.test', { fetch: server.fetch });
}

export async function q<T = Record<string, unknown>>(c: Client, sql: string, args: (string | number | null)[] = []): Promise<T[]> {
  return (await c.execute({ sql, args })).rows as unknown as T[];
}

export const exists = (p: string) => fs.existsSync(p);
