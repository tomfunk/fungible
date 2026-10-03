import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../mcp/create-server.js';

export interface McpCallResult {
  /** Text of the first content block ('' when there is none). */
  text: string;
  /** True when the SDK flagged the result as an error (validation failure or a thrown tool). */
  isError: boolean;
  /** The untouched callTool result. */
  raw: Awaited<ReturnType<Client['callTool']>>;
}

export interface McpTestClient {
  client: Client;
  /** Spy passed as createMcpServer's afterWrite; assert it fires exactly when a write happened. */
  afterWrite: ReturnType<typeof vi.fn<() => void>>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult>;
  listTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']>;
  /** Closes client and server. Idempotent. */
  close(): Promise<void>;
}

/**
 * In-process MCP server + client over an in-memory transport: no process, no
 * port, a few ms per test. Exercises the real Zod schemas in mcp/create-server.ts
 * (unlike calling executeTool directly, which skips them).
 *
 * The test file must mock core/db.js first (the usual vi.mock('../core/db.js')
 * with makeTestDb), because createMcpServer reaches the database through
 * core/tools.ts. Pair with beforeEach/afterEach:
 *
 *   let mcp: McpTestClient;
 *   beforeEach(async () => { mcp = await makeMcpClient(); });
 *   afterEach(() => mcp.close());
 *
 *   const r = await mcp.callTool('add_transaction', { ... });
 *   expect(r.isError).toBe(false);
 *   expect(mcp.afterWrite).toHaveBeenCalledTimes(1);
 *
 * `opts.afterWrite` replaces the default spy (the returned `afterWrite` is then
 * that function).
 */
export async function makeMcpClient(opts: { afterWrite?: () => void } = {}): Promise<McpTestClient> {
  const afterWrite = (opts.afterWrite ?? vi.fn<() => void>()) as ReturnType<typeof vi.fn<() => void>>;
  const server = createMcpServer({ afterWrite });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let closed = false;
  return {
    client,
    afterWrite,
    async callTool(name, args = {}) {
      const raw = await client.callTool({ name, arguments: args });
      const content = (raw as { content?: { type: string; text?: string }[] }).content ?? [];
      return { text: content[0]?.text ?? '', isError: raw.isError === true, raw };
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await server.close();
    },
  };
}
