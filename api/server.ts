import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env') });

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from '../core/db.js';
import { executeTool, TOOL_DEFS } from '../core/tools.js';

initDb();

const PORT = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
const API_KEY = process.env.FUNGIBLE_API_KEY;
const VALID_TOOLS = new Set(TOOL_DEFS.map((t) => t.name));

if (!API_KEY) {
  console.warn('[fungible-api] Warning: FUNGIBLE_API_KEY not set — all requests accepted');
}

function send(res: ServerResponse, status: number, body: object) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // Auth
  if (API_KEY) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${API_KEY}`) {
      return send(res, 401, { error: 'Unauthorized' });
    }
  }

  // Route: POST /tools/:name
  const match = req.method === 'POST' && req.url?.match(/^\/tools\/([^/?]+)$/);
  if (!match) {
    return send(res, 404, { error: 'Not found. Use POST /tools/:name' });
  }

  const toolName = match[1];
  if (!VALID_TOOLS.has(toolName)) {
    return send(res, 404, { error: `unknown tool: ${toolName}` });
  }

  let input: Record<string, unknown> = {};
  const raw = await readBody(req);
  if (raw) {
    try {
      input = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'invalid JSON body' });
    }
  }

  try {
    const result = await executeTool(toolName, input);
    send(res, 200, { result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`[fungible-api] Listening on http://localhost:${PORT}`);
});
