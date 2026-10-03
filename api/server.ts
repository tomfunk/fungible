import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from 'dotenv';
import { DATA_DIR } from '../core/paths.js';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { executeTool, TOOL_DEFS } from '../core/tools.js';
import { notifyChange } from '../core/refresh.js';
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

export interface ApiServerOptions {
  /** Listen port; 0 picks an ephemeral port. Default: FUNGIBLE_API_PORT, else 3456. */
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

const VALID_TOOLS = new Set(TOOL_DEFS.map((t) => t.name));

/**
 * Start the REST API. Resolves with the listening server; rejects on any
 * listen error (EADDRINUSE, EACCES, EADDRNOTAVAIL, ...).
 * Legacy form startApiServer(port, { quiet }) still works.
 */
export function startApiServer(
  portOrOpts: number | ApiServerOptions = {},
  legacyOpts: { quiet?: boolean } = {},
): Promise<Server> {
  const opts: ApiServerOptions = typeof portOrOpts === 'number' ? { port: portOrOpts, ...legacyOpts } : portOrOpts;

  const envPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '', 10);
  const port = opts.port ?? (Number.isNaN(envPort) ? 3456 : envPort);
  const host = opts.host ?? process.env.FUNGIBLE_BIND_HOST ?? '127.0.0.1';
  const apiKey = ('apiKey' in opts ? opts.apiKey : process.env.FUNGIBLE_API_KEY) || undefined;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // A concrete (non-wildcard) bind address is a name clients legitimately use.
  const allowedHosts = [...(opts.allowedHosts ?? [])];
  if (host !== '0.0.0.0' && host !== '::') allowedHosts.push(host);

  if (!opts.quiet) {
    if (!apiKey) console.warn('[fungible-api] Warning: FUNGIBLE_API_KEY not set — all requests accepted');
    if (!isLocalHost(host) && !apiKey) {
      console.warn(`[fungible-api] Warning: listening on non-local address ${host} without FUNGIBLE_API_KEY`);
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // 1) Host / Origin (DNS rebinding, cross-site requests)
    const origin = checkRequestOrigin(req.headers, allowedHosts);
    if (!origin.ok) return sendJson(res, 403, { error: `Forbidden: ${origin.reason}` });

    // 2) auth
    if (apiKey && !bearerMatches(req.headers['authorization'], apiKey)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    // 3) method / route
    const path = (req.url ?? '').split('?')[0];
    const isNotify = req.method === 'POST' && path === '/notify';
    const match = req.method === 'POST' ? path.match(/^\/tools\/([^/]+)$/) : null;
    if (!isNotify && !match) return sendJson(res, 404, { error: 'Not found. Use POST /tools/:name' });
    const toolName = match?.[1];
    if (toolName !== undefined && !VALID_TOOLS.has(toolName)) {
      return sendJson(res, 404, { error: `unknown tool: ${toolName}` });
    }

    // 4) content type
    if (!isJsonContentType(req.headers['content-type'])) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' });
    }

    // 5) body size
    const body = await readBodyLimited(req, maxBodyBytes);
    if (!body.ok) return sendTooLarge(req, res);

    if (isNotify) {
      notifyChange();
      return sendJson(res, 200, { ok: true });
    }

    // 6) JSON parse
    let input: Record<string, unknown> = {};
    if (body.raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.raw);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return sendJson(res, 400, { error: 'JSON body must be an object' });
      }
      input = parsed as Record<string, unknown>;
    }

    try {
      const result = await executeTool(toolName!, input);
      sendJson(res, 200, { result });
    } catch (err) {
      console.error(`[fungible-api] tool ${toolName} failed:`, err);
      sendJson(res, 500, { error: 'internal error' });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[fungible-api] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  return new Promise<Server>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') console.warn(`[fungible-api] port ${port} in use — REST API server not started`);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      if (!opts.quiet) {
        const addr = server.address();
        const actual = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`[fungible-api] Listening on http://${host}:${actual}`);
      }
      resolve(server);
    });
  });
}

// Standalone entrypoint
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  config({ path: join(DATA_DIR, '.env') });
  await initDb();
  backupDb().catch(() => {});
  await startApiServer();
}
