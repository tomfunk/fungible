import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './create-server.js';

export function startMcpHttpServer(port: number): void {
  const httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: unknown;
    if (raw) {
      try { body = JSON.parse(raw); } catch { /* let transport handle malformed JSON */ }
    }

    // Stateless: new server+transport per request so no session state is needed
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(port);
}
