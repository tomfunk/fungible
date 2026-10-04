import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import type { AddressInfo } from 'node:net';

vi.mock('../core/db.js', () => ({ db: {}, initDb: vi.fn() }));
vi.mock('../core/backup.js', () => ({ backupDb: vi.fn() }));
vi.mock('../core/refresh.js', () => ({ notifyChange: vi.fn(), onRefresh: vi.fn() }));
vi.mock('../core/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tools.js')>();
  return { ...actual, executeTool: vi.fn(async () => 'tool-output') };
});

import { startApiServer } from '../api/server.js';
import { executeTool, TOOL_DEFS } from '../core/tools.js';
import { notifyChange } from '../core/refresh.js';
import { rawRequest, streamBody } from './helpers/makeHttpApi.js';

const KEY = 'secret-key';
const TOOL = TOOL_DEFS[0].name;

const connectHost = (o: { host?: string }) => (o.host && o.host !== '0.0.0.0' && o.host !== '::' ? o.host : undefined);
let servers: http.Server[] = [];
async function start(opts: Exclude<Parameters<typeof startApiServer>[0], number> = {}) {
  const server = await startApiServer({ port: 0, quiet: true, apiKey: undefined, ...(opts as object) });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    post: (path: string, body: unknown = {}, headers: Record<string, string | null> = {}) =>
      rawRequest(port, 'POST', path, {
        connectHost: connectHost(opts),
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
    request: (method: string, path: string, o: { body?: string; headers?: Record<string, string | null> } = {}) =>
      rawRequest(port, method, path, o),
  };
}

beforeEach(() => {
  vi.mocked(executeTool).mockClear();
  vi.mocked(executeTool).mockImplementation(async () => 'tool-output');
  vi.mocked(notifyChange).mockClear();
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
  vi.unstubAllEnvs();
});

describe('success path', () => {
  it('returns {result} and passes the parsed body to the tool', async () => {
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`, { a: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ result: 'tool-output' });
    expect(r.headers['content-type']).toContain('application/json');
    expect(executeTool).toHaveBeenCalledWith(TOOL, { a: 1 });
  });

  it('treats an empty body as {}', async () => {
    const api = await start();
    expect((await api.post(`/tools/${TOOL}`, '')).status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(TOOL, {});
  });

  it('strips a query string and accepts the request', async () => {
    const api = await start();
    expect((await api.post(`/tools/${TOOL}?x=1`, {})).status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(TOOL, {});
  });

  it('accepts application/json with a charset and any casing', async () => {
    const api = await start();
    for (const ct of ['application/json; charset=utf-8', 'APPLICATION/JSON']) {
      expect((await api.post(`/tools/${TOOL}`, {}, { 'Content-Type': ct })).status).toBe(200);
    }
  });

  it('serves several servers on ephemeral ports at once', async () => {
    const a = await start();
    const b = await start();
    expect(a.port).not.toBe(b.port);
    expect((await a.post(`/tools/${TOOL}`)).status).toBe(200);
    expect((await b.post(`/tools/${TOOL}`)).status).toBe(200);
  });
});

describe('routing', () => {
  it.each(['__proto__', 'constructor', 'toString', 'nope'])('unknown tool %s is 404', async (name) => {
    const api = await start();
    const r = await api.post(`/tools/${name}`);
    expect(r.status).toBe(404);
    expect(r.json.error).toMatch(/unknown tool/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT', 'DELETE'])('%s on a tool path is 404', async (method) => {
    const api = await start();
    expect((await api.request(method, `/tools/${TOOL}`)).status).toBe(404);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('trailing slash and unknown paths are 404', async () => {
    const api = await start();
    expect((await api.post(`/tools/${TOOL}/`)).status).toBe(404);
    expect((await api.post('/elsewhere')).status).toBe(404);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('sends no CORS headers and OPTIONS is 404', async () => {
    const api = await start();
    const opt = await api.request('OPTIONS', `/tools/${TOOL}`, { headers: { Origin: 'http://localhost:5173' } });
    expect(opt.status).toBe(404);
    const ok = await api.post(`/tools/${TOOL}`, {}, { Origin: 'http://localhost:5173' });
    for (const r of [opt, ok]) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('auth', () => {
  it.each([
    ['no header', null],
    ['wrong key', 'Bearer nope'],
    ['empty bearer', 'Bearer'],
    ['lowercase scheme', `bearer ${KEY}`],
    ['Basic scheme', `Basic ${KEY}`],
    // trailing space is stripped as optional whitespace by the HTTP parser; covered in http-guard.test.ts
    ['key prefix doubled', `Bearer ${KEY}${KEY}`],
  ])('%s is 401', async (_n, header) => {
    const api = await start({ apiKey: KEY });
    const r = await api.post(`/tools/${TOOL}`, {}, { Authorization: header });
    expect(r.status).toBe(401);
    expect(r.json.error).toBeTypeOf('string');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('the correct key is 200', async () => {
    const api = await start({ apiKey: KEY });
    expect((await api.post(`/tools/${TOOL}`, {}, { Authorization: `Bearer ${KEY}` })).status).toBe(200);
  });

  it('/notify needs the key and calls notifyChange once', async () => {
    const api = await start({ apiKey: KEY });
    expect((await api.post('/notify', '')).status).toBe(401);
    expect(notifyChange).not.toHaveBeenCalled();
    const ok = await api.post('/notify', '', { Authorization: `Bearer ${KEY}` });
    expect(ok.status).toBe(200);
    expect(notifyChange).toHaveBeenCalledTimes(1);
  });

  it('keyless loopback accepts requests with no Authorization (deliberate: documented dev mode)', async () => {
    const api = await start();
    expect((await api.post(`/tools/${TOOL}`)).status).toBe(200);
  });
});

describe('content type', () => {
  it.each([
    ['text/plain', 'text/plain'],
    ['urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['text/json', 'text/json'],
    ['application/jsonx', 'application/jsonx'],
    ['missing', null],
  ])('%s is 415', async (_n, ct) => {
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`, '{}', { 'Content-Type': ct });
    expect(r.status).toBe(415);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('/notify without a content type is 415 even with an empty body', async () => {
    const api = await start();
    expect((await api.post('/notify', '', { 'Content-Type': null })).status).toBe(415);
    expect(notifyChange).not.toHaveBeenCalled();
  });
});

describe('Host / Origin guard', () => {
  it.each(['http://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.com', 'null'])(
    'Origin %s is 403',
    async (origin) => {
      const api = await start();
      const r = await api.post(`/tools/${TOOL}`, {}, { Origin: origin });
      expect(r.status).toBe(403);
      expect(executeTool).not.toHaveBeenCalled();
    },
  );

  it.each(['attacker.example', 'attacker.example:3456', 'localhost.evil.com'])('Host %s is 403', async (host) => {
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`, {}, { Host: host });
    expect(r.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('a missing Host header is 403', async () => {
    const api = await start();
    const r = await new Promise<number>((resolve, reject) => {
      const sock = new net.Socket();
      sock.connect(api.port, '127.0.0.1', () =>
        sock.write('POST /notify HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
      let data = '';
      sock.on('data', (d: Buffer) => (data += d));
      sock.on('end', () => resolve(Number(data.split(' ')[1])));
      sock.on('error', reject);
    });
    // Node itself rejects HTTP/1.1 requests without Host with 400; either way the tool never runs.
    expect([400, 403]).toContain(r);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it.each(['localhost', 'localhost:3456', '127.0.0.1', '127.0.0.1:3456', '[::1]', '[::1]:3456', 'LOCALHOST'])(
    'Host %s is allowed',
    async (host) => {
      const api = await start();
      expect((await api.post(`/tools/${TOOL}`, {}, { Host: host })).status).toBe(200);
    },
  );

  it('allows a local browser Origin and an absent Origin', async () => {
    const api = await start();
    expect((await api.post(`/tools/${TOOL}`, {}, { Origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await api.post(`/tools/${TOOL}`)).status).toBe(200);
  });

  it('guards /notify too', async () => {
    const api = await start();
    expect((await api.post('/notify', '', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await api.post('/notify', '', { Host: 'attacker.example' })).status).toBe(403);
    expect(notifyChange).not.toHaveBeenCalled();
  });

  it('403 takes precedence over 401', async () => {
    const api = await start({ apiKey: KEY });
    const r = await api.post(`/tools/${TOOL}`, {}, { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });

  it('honours allowedHosts', async () => {
    const api = await start({ allowedHosts: ['api.internal'] });
    expect((await api.post(`/tools/${TOOL}`, {}, { Host: 'api.internal:3456' })).status).toBe(200);
  });
});

describe('body handling', () => {
  it('malformed JSON is 400', async () => {
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`, '{not json');
    expect(r.status).toBe(400);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '5', '"x"', 'true'])('non-object JSON %s is 400', async (raw) => {
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`, raw);
    expect(r.status).toBe(400);
    expect(r.json.error).toBeTypeOf('string');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('an oversize body is 413 and the server survives', async () => {
    const api = await start({ maxBodyBytes: 100 });
    const big = JSON.stringify({ pad: 'x'.repeat(500) });
    const r = await api.post(`/tools/${TOOL}`, big);
    expect(r.status).toBe(413);
    expect(executeTool).not.toHaveBeenCalled();
    expect((await api.post(`/tools/${TOOL}`, {})).status).toBe(200);
  });

  it('a body of exactly the cap is accepted, one byte more is not', async () => {
    const api = await start({ maxBodyBytes: 100 });
    const pad = (n: number) => JSON.stringify({ p: 'x'.repeat(n) });
    const base = Buffer.byteLength(pad(0));
    expect((await api.post(`/tools/${TOOL}`, pad(100 - base))).status).toBe(200);
    expect((await api.post(`/tools/${TOOL}`, pad(101 - base))).status).toBe(413);
  });

  it('a streamed (chunked, no Content-Length) body over the cap is 413 and the server survives', async () => {
    const api = await start({ maxBodyBytes: 1000 });
    // 413, or a reset if the server drops the socket before the client reads it; never a 2xx/400 from parsing the body
    expect([413, 'reset']).toContain(await streamBody(api.port, `/tools/${TOOL}`, 50, 1000));
    expect(executeTool).not.toHaveBeenCalled();
    expect((await api.post(`/tools/${TOOL}`, {})).status).toBe(200);
  });

  it('counts bytes, not characters', async () => {
    const api = await start({ maxBodyBytes: 100 });
    // 40 chars but 120 bytes
    const body = JSON.stringify({ p: 'é'.repeat(20) + '€'.repeat(20) });
    expect(body.length).toBeLessThan(100);
    expect(Buffer.byteLength(body)).toBeGreaterThan(100);
    expect((await api.post(`/tools/${TOOL}`, body)).status).toBe(413);
  });

  it('413 does not leak into 415: content type is checked first', async () => {
    const api = await start({ maxBodyBytes: 10 });
    const r = await api.post(`/tools/${TOOL}`, 'x'.repeat(500), { 'Content-Type': 'text/plain' });
    expect(r.status).toBe(415);
  });
});

describe('tool failures', () => {
  it('an Error becomes a generic 500 with no stack or paths, and the server survives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(executeTool).mockRejectedValueOnce(new Error('boom at /Users/x/file.ts'));
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`);
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal error' });
    expect(r.text).not.toMatch(/\n\s+at |\.ts|\.js|node_modules|boom/);
    expect((await api.post(`/tools/${TOOL}`)).status).toBe(200);
  });

  it('a non-Error throw is also generic', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(executeTool).mockRejectedValueOnce('plain string');
    const api = await start();
    const r = await api.post(`/tools/${TOOL}`);
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal error' });
  });
});

describe('startup options', () => {
  it('falls back to the environment, but an explicit option wins, even undefined', async () => {
    vi.stubEnv('FUNGIBLE_API_KEY', 'env-key');
    const viaEnv = await startApiServer({ port: 0, quiet: true });
    servers.push(viaEnv);
    const envPort = (viaEnv.address() as AddressInfo).port;
    expect((await rawRequest(envPort, 'POST', `/tools/${TOOL}`, { body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(401);
    expect((await rawRequest(envPort, 'POST', `/tools/${TOOL}`, { body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer env-key' } })).status).toBe(200);

    const explicit = await start({ apiKey: 'opt-key' });
    expect((await explicit.post(`/tools/${TOOL}`, {}, { Authorization: 'Bearer env-key' })).status).toBe(401);

    const none = await start({ apiKey: undefined });
    expect((await none.post(`/tools/${TOOL}`)).status).toBe(200);
  });

  it('reads the port from the environment when none is given', async () => {
    vi.stubEnv('FUNGIBLE_API_PORT', '0');
    const s = await startApiServer({ quiet: true, apiKey: undefined });
    servers.push(s);
    expect((s.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('keeps the legacy (port, {quiet}) call form working', async () => {
    const s = await startApiServer(0, { quiet: true });
    servers.push(s);
    expect(s.listening).toBe(true);
  });

  it('rejects with EADDRINUSE and leaves the first server running', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await start();
    await expect(startApiServer({ port: first.port, quiet: true, apiKey: undefined })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect((await first.post(`/tools/${TOOL}`)).status).toBe(200);
  });

  it('rejects on an unusable host', async () => {
    await expect(startApiServer({ port: 0, host: '203.0.113.77', quiet: true, apiKey: undefined })).rejects.toMatchObject({
      code: expect.stringMatching(/EADDRNOTAVAIL|EINVAL/),
    });
  });
});

const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe('bind host as an allowed Host', () => {
  it('a wildcard bind does NOT make 0.0.0.0 an accepted Host', async () => {
    const api = await start({ host: '0.0.0.0', apiKey: KEY });
    expect((await api.post(`/tools/${TOOL}`, {}, { Host: '0.0.0.0', Authorization: `Bearer ${KEY}` })).status).toBe(403);
  });

  it.skipIf(!lanIp)('a concrete non-loopback bind accepts its own address as Host, and a wildcard bind does not', async () => {
    const concrete = await start({ host: lanIp!, apiKey: KEY });
    const ok = await concrete.post(`/tools/${TOOL}`, {}, { Host: `${lanIp}:${concrete.port}`, Authorization: `Bearer ${KEY}` });
    expect(ok.status).toBe(200);
    const wild = await start({ host: '0.0.0.0', apiKey: KEY });
    const no = await wild.post(`/tools/${TOOL}`, {}, { Host: `${lanIp}:${wild.port}`, Authorization: `Bearer ${KEY}` });
    expect(no.status).toBe(403);
  });

  it('an empty-string apiKey means no auth, not "Bearer "', async () => {
    const api = await start({ apiKey: '' });
    expect((await api.post(`/tools/${TOOL}`)).status).toBe(200);
  });
});
