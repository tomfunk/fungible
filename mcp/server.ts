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
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
