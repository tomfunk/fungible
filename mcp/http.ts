import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './create-server.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  bearerMatches,
  checkRequestOrigin,
  isJsonContentType,
  isLocalHost,
  readBodyLimited,
  sendJson,
  sendTooLarge,
} from '../core/http-guard.js';

export interface McpHttpOptions {
  /** Listen port; 0 picks an ephemeral port. Default: FUNGIBLE_MCP_PORT, else 3741. */
  port?: number;
  /** Bind address. Default: FUNGIBLE_BIND_HOST, else 127.0.0.1. */
  host?: string;
  /** Bearer token. Absent = FUNGIBLE_API_KEY; an explicit `undefined` = no auth. */
  apiKey?: string | undefined;
  quiet?: boolean;
  /** Request-body cap in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** Extra Host/Origin hostnames accepted besides loopback names. */
  allowedHosts?: string[];
}

/**
 * Start the HTTP MCP server. Resolves with the listening server. Rejects on
 * listen errors, and refuses (without listening) a non-local bind address
 * when no API key is configured.
 */
export function startMcpHttpServer(portOrOpts: number | McpHttpOptions = {}): Promise<Server> {
  const opts: McpHttpOptions = typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts;

  const envPort = parseInt(process.env.FUNGIBLE_MCP_PORT ?? '', 10);
  const port = opts.port ?? (Number.isNaN(envPort) ? 3741 : envPort);
  const host = opts.host ?? process.env.FUNGIBLE_BIND_HOST ?? '127.0.0.1';
  const apiKey = ('apiKey' in opts ? opts.apiKey : process.env.FUNGIBLE_API_KEY) || undefined;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedHosts = [...(opts.allowedHosts ?? [])];
  if (host !== '0.0.0.0' && host !== '::') allowedHosts.push(host);

  if (!isLocalHost(host) && !apiKey) {
    return Promise.reject(
      new Error(`[fungible-mcp] refusing to listen on non-local address ${host} without FUNGIBLE_API_KEY set`),
    );
  }

  const httpServer = createServer(async (req, res) => {
    try {
      // 1) Host / Origin
      const origin = checkRequestOrigin(req.headers, allowedHosts);
      if (!origin.ok) return sendJson(res, 403, { error: `Forbidden: ${origin.reason}` });

      // 2) auth
      if (apiKey && !bearerMatches(req.headers['authorization'], apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }

      let body: unknown;
      if (req.method === 'POST') {
        // 4) content type, 5) size, 6) JSON
        if (!isJsonContentType(req.headers['content-type'])) {
          return sendJson(res, 415, { error: 'Content-Type must be application/json' });
        }
        const read = await readBodyLimited(req, maxBodyBytes);
        if (!read.ok) return sendTooLarge(req, res);
        try {
          body = JSON.parse(read.raw);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
      }

      // Stateless: new server+transport per request so no session state is needed.
      // No afterWrite hook: executeToolWithEffect already fires notifyChange in this process.
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[fungible-mcp] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });

  return new Promise<Server>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') console.warn(`[fungible-mcp] port ${port} in use — HTTP MCP server not started`);
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      resolve(httpServer);
    });
  });
}
