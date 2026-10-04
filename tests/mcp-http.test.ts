import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// createMcpServer reaches the database through core/tools.ts: never touch ~/.fungible.
vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../core/refresh.js', () => ({ notifyChange: vi.fn(), onRefresh: vi.fn() }));

import { startMcpHttpServer } from '../mcp/http.js';
import { createMcpServer } from '../mcp/create-server.js';
import { notifyChange } from '../core/refresh.js';
import { db } from '../core/db.js';
import { rawRequest, streamBody } from './helpers/makeHttpApi.js';

const KEY = 'mcp-key';
const ACCEPT = 'application/json, text/event-stream';
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

let servers: http.Server[] = [];
async function start(opts: Exclude<Parameters<typeof startMcpHttpServer>[0], number> = {}) {
  const server = await startMcpHttpServer({ port: 0, apiKey: undefined, ...(opts as object) });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const post = (body: unknown, headers: Record<string, string | null> = {}) =>
    rawRequest(port, 'POST', '/mcp', {
      connectHost: opts.host && opts.host !== '0.0.0.0' ? opts.host : undefined,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers },
    });
  return { server, port, post };
}

beforeEach(() => vi.mocked(notifyChange).mockClear());
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

describe('keyless loopback (deliberate: matches the documented dev mode)', () => {
  it('initialize and tools/list work, and the tool count matches the in-process server', async () => {
    const { port } = await start();
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const remote = (await client.listTools()).tools;
    await client.close();

    const { Client: C } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const local = createMcpServer();
    await local.connect(a);
    const lc = new C({ name: 't', version: '1' });
    await lc.connect(b);
    const expected = (await lc.listTools()).tools.length;
    await lc.close();

    expect(remote.length).toBe(expected);
    expect(remote.length).toBeGreaterThan(5);
  });

  it('a tool call returns data', async () => {
    const { port } = await start();
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const r = await client.callTool({ name: 'list_accounts', arguments: {} });
    await client.close();
    expect(r.isError).toBeFalsy();
    expect((r.content as { text: string }[])[0].text).toBeTypeOf('string');
  });

  it('is stateless: no Mcp-Session-Id is issued', async () => {
    const { post } = await start();
    const r = await post(INIT);
    expect(r.status).toBe(200);
    expect(r.headers['mcp-session-id']).toBeUndefined();
  });

  it('an HTTP write fires notifyChange exactly once (same as the stdio path)', async () => {
    const { port } = await start();
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    await db.execute("INSERT INTO accounts (id, name, type) VALUES ('a1', 'Checking', 'depository')");
    const r = await client.callTool({
      name: 'add_transaction',
      arguments: { account_id: 'a1', date: '2026-01-02', name: 'Coffee', amount: 4.5, category: 'Food & Drink' },
    });
    await client.close();
    expect(r.isError).toBeFalsy();
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });
});

describe('bind safety', () => {
  it('refuses a non-local bind without a key and never listens', async () => {
    const spy = vi.spyOn(http.Server.prototype, 'listen');
    await expect(startMcpHttpServer({ port: 0, host: '0.0.0.0', apiKey: undefined })).rejects.toThrow(/FUNGIBLE_API_KEY.*|refus/);
    await expect(startMcpHttpServer({ port: 0, host: '0.0.0.0', apiKey: undefined })).rejects.toThrow(/refus/i);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an empty key does not count as a key', async () => {
    await expect(startMcpHttpServer({ port: 0, host: '0.0.0.0', apiKey: '' })).rejects.toThrow(/refus/i);
  });

  it('starts on a non-local bind when a key is set, and still requires it', async () => {
    const { post } = await start({ host: '0.0.0.0', apiKey: KEY });
    expect((await post(INIT)).status).toBe(401);
    expect((await post(INIT, { Authorization: `Bearer ${KEY}` })).status).toBe(200);
  });
});

describe('guards', () => {
  it.each([
    ['no header', null],
    ['wrong', 'Bearer nope'],
    ['lowercase scheme', `bearer ${KEY}`],
    ['Basic', `Basic ${KEY}`],
  ])('auth: %s is 401', async (_n, header) => {
    const { post } = await start({ apiKey: KEY });
    expect((await post(INIT, { Authorization: header })).status).toBe(401);
  });

  it.each([
    ['text/plain', 'text/plain'],
    ['urlencoded', 'application/x-www-form-urlencoded'],
    ['missing', null],
  ])('content type %s is 415', async (_n, ct) => {
    const { post } = await start();
    const r = await post(INIT, { 'Content-Type': ct });
    expect(r.status).toBe(415);
    expect(r.json.error).toBeTypeOf('string');
  });

  it('accepts application/json with a charset', async () => {
    const { post } = await start();
    expect((await post(INIT, { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
  });

  it.each([
    ['Origin', { Origin: 'http://evil.example' }],
    ['Origin null', { Origin: 'null' }],
    ['Origin prefix trick', { Origin: 'http://127.0.0.1.evil.com' }],
    ['Host', { Host: 'attacker.example' }],
    ['Host prefix trick', { Host: 'localhost.evil.com' }],
  ])('%s is 403 and precedes auth', async (_n, headers) => {
    const { post } = await start({ apiKey: KEY });
    expect((await post(INIT, headers)).status).toBe(403);
  });

  it('allows a local browser Origin', async () => {
    const { post } = await start();
    expect((await post(INIT, { Origin: 'http://localhost:5173' })).status).toBe(200);
  });

  it('malformed JSON is 400 without a stack', async () => {
    const { post } = await start();
    const r = await post('{nope');
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTypeOf('string');
    expect(r.text).not.toMatch(/\n\s+at |\.ts|\.js|node_modules/);
  });

  it('an oversize body is 413 and the server survives', async () => {
    const { post } = await start({ maxBodyBytes: 200 });
    const big = JSON.stringify({ ...INIT, pad: 'x'.repeat(1000) });
    expect((await post(big)).status).toBe(413);
    expect((await post(INIT)).status).toBe(200);
  });

  it('a streamed (chunked, no Content-Length) body over the cap is 413 and the server survives', async () => {
    const { port, post } = await start({ maxBodyBytes: 1000 });
    // 413, or a reset if the server drops the socket before the client reads it; never a 2xx/400 from parsing the body
    expect([413, 'reset']).toContain(await streamBody(port, '/mcp', 50, 1000));
    expect((await post(INIT)).status).toBe(200);
  });

  it('pins stateless GET/DELETE behaviour and the Accept requirement', async () => {
    const { port, post } = await start();
    const get = await rawRequest(port, 'GET', '/mcp');
    const del = await rawRequest(port, 'DELETE', '/mcp');
    expect({ get: get.status, del: del.status }).toEqual({ get: 406, del: 200 }); // GET needs Accept: text/event-stream; stateless DELETE is a harmless no-op
    const noAccept = await post(INIT, { Accept: null });
    expect(noAccept.status).toBe(406);
  });
});

const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe('bind host as an allowed Host', () => {
  it('a wildcard bind does NOT make 0.0.0.0 an accepted Host', async () => {
    const { post } = await start({ host: '0.0.0.0', apiKey: KEY });
    expect((await post(INIT, { Host: '0.0.0.0', Authorization: `Bearer ${KEY}` })).status).toBe(403);
  });

  it.skipIf(!lanIp)('a concrete non-loopback bind accepts its own address as Host, and a wildcard bind does not', async () => {
    const concrete = await start({ host: lanIp!, apiKey: KEY });
    expect((await concrete.post(INIT, { Host: `${lanIp}:${concrete.port}`, Authorization: `Bearer ${KEY}` })).status).toBe(200);
    const wild = await start({ host: '0.0.0.0', apiKey: KEY });
    expect((await wild.post(INIT, { Host: `${lanIp}:${wild.port}`, Authorization: `Bearer ${KEY}` })).status).toBe(403);
  });
});
