import 'dotenv/config';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { initDb } from '../core/db.js';
import {
  clampDaysRequested, completeLink, createFlowLinkToken, linkPage, successPage,
} from '../core/plaid-link-flow.js';

const PORT = 4747;

// History window (days of transactions Plaid backfills) is set by the TUI via
// PLAID_DAYS_REQUESTED. It's locked at Item creation and can't be changed later.
function resolveDaysRequested(): number | undefined {
  const raw = process.env.PLAID_DAYS_REQUESTED;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return undefined;
  return clampDaysRequested(n);
}

/** Single-line progress line. The TUI pipes this stdout straight into the link
 *  panel, so every step reported here is visible to the user while they wait. */
function log(msg: string) {
  console.log(msg);
}

async function main() {
  await initDb();
  // Set by the TUI's [u] update link to re-authorize an existing connection in
  // place rather than link a new one.
  const updateItemId = process.env.PLAID_UPDATE_ITEM_ID || undefined;
  const daysRequested = resolveDaysRequested();

  log(updateItemId ? 'Creating Plaid update-mode link token…' : 'Creating Plaid link token…');
  const linkToken = await createFlowLinkToken({ updateItemId, daysRequested });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(linkPage(linkToken, { updateMode: !!updateItemId }));
      return;
    }

    if (req.method === 'POST' && req.url === '/callback') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Each of these is a single line on purpose: the TUI renders only the
          // last line of a stdout chunk (tui/Accounts.tsx), so a multi-line log
          // would hide everything but its final line.
          log(updateItemId
            ? 'Credentials received — updating link…'
            : 'Account link received from Plaid — exchanging token…');
          const { itemId, institutionName, updateMode } = await completeLink(body, { updateItemId, daysRequested });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(successPage({ updateMode, returnTo: 'the terminal' }));

          log(`✓ ${updateMode ? 'Link updated' : 'Connected'}: ${institutionName ?? itemId} — returning to fungible…`);

          setTimeout(() => server.close(), 1000);
        } catch (e: any) {
          // Also to stderr: the TUI flags the panel as failed on stderr, so the
          // user sees the reason instead of the last progress line sitting there
          // looking hung.
          console.error(`Link failed: ${e.message}`);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(e.message);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    log(`Opening ${url} …`);
    execFile('open', [url]);
    log('Waiting for you to connect in the browser…');
  });
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
