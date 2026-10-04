import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mcp/server.ts is a top-level script: importing it wires createMcpServer to the stdio transport.
// Capture the afterWrite hook it passes and exercise the notify call it makes to the REST API.
let afterWrite: (() => void) | undefined;
vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('../core/db.js', () => ({ db: {}, initDb: vi.fn(async () => {}) }));
vi.mock('../core/backup.js', () => ({ backupDb: vi.fn(async () => {}) }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn() }));
vi.mock('../mcp/create-server.js', () => ({
  createMcpServer: vi.fn((opts: { afterWrite: () => void }) => {
    afterWrite = opts.afterWrite;
    return { connect: vi.fn(async () => {}) };
  }),
}));

async function loadAndFire(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const fetchMock = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  await import('../mcp/server.js');
  afterWrite!();
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit];
}

beforeEach(() => { afterWrite = undefined; });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('stdio MCP -> REST API /notify call', () => {
  it('POSTs /notify with a JSON content type and body (the API 415s otherwise)', async () => {
    const [url, init] = await loadAndFire({ FUNGIBLE_API_PORT: '4567', FUNGIBLE_API_KEY: '' });
    expect(url).toBe('http://localhost:4567/notify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe('{}');
  });

  it('adds the bearer key when FUNGIBLE_API_KEY is set (the API 401s otherwise)', async () => {
    const [, init] = await loadAndFire({ FUNGIBLE_API_KEY: 'k1' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k1' });
  });
});
