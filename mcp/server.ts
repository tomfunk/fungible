import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env') });
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { createMcpServer } from './create-server.js';

await initDb();
backupDb().catch(() => {});
const apiPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
const server = createMcpServer({
  afterWrite: () => {
    // The API requires a JSON content type (and the bearer key when one is configured).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.FUNGIBLE_API_KEY) headers.Authorization = `Bearer ${process.env.FUNGIBLE_API_KEY}`;
    fetch(`http://localhost:${apiPort}/notify`, { method: 'POST', headers, body: '{}' }).catch(() => {});
  },
});


const transport = new StdioServerTransport();
await server.connect(transport);
