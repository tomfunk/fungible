import http from 'node:http';
import { shell } from 'electron';
import {
  clampDaysRequested, completeLink, createFlowLinkToken, linkPage, successPage,
} from '../../core/plaid-link-flow.js';
import { notifyChange } from '../../core/refresh.js';
import { isPlaidConfigured } from '../../core/plaid.js';

// Browser-based Plaid Link flow. Uses the system browser (bank OAuth redirects
// often reject embedded webviews) and an ephemeral localhost callback server.
// The pages and the persistence live in core/plaid-link-flow.ts, shared with
// scripts/link.ts; only the server lifecycle below is Electron-specific.

let activeLink: Promise<{ institutionName: string | null; updateMode: boolean }> | null = null;
let cancelActive: (() => void) | null = null;

const MAX_CALLBACK_BODY = 1_000_000;

/** Abort an in-progress link flow (e.g. window closed): closes the callback
 *  server, rejects the pending promise, and allows a fresh retry. */
export function cancelActivePlaidLink() {
  cancelActive?.();
}

/**
 * Starts the link flow in the system browser. Resolves when a bank is
 * connected, rejects on timeout (10 min) or server failure.
 *
 * Passing `updateItemId` updates the credentials on that existing connection
 * instead of adding a new one, keeping its accounts and transactions intact.
 */
export function runPlaidLink(
  daysRequested?: number,
  updateItemId?: string,
): Promise<{ institutionName: string | null; updateMode: boolean }> {
  if (activeLink) return activeLink;
  if (!isPlaidConfigured()) {
    return Promise.reject(new Error('Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET in ~/.fungible/.env'));
  }

  activeLink = new Promise((resolve, reject) => {
    void (async () => {
      const days = daysRequested !== undefined ? clampDaysRequested(daysRequested) : undefined;
      const linkToken = await createFlowLinkToken({ updateItemId, daysRequested: days });

      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(linkPage(linkToken, { updateMode: !!updateItemId }));
          return;
        }

        if (req.method === 'POST' && req.url === '/callback') {
          let body = '';
          let overflow = false;
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_CALLBACK_BODY && !overflow) {
              overflow = true;
              res.writeHead(413);
              res.end();
              req.destroy();
            }
          });
          req.on('end', async () => {
            if (overflow) return;
            try {
              const { institutionName, updateMode } = await completeLink(body, { updateItemId, daysRequested: days });

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(successPage({ updateMode, returnTo: 'fungible' }));
              finish();
              notifyChange();
              resolve({ institutionName, updateMode });
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end(e instanceof Error ? e.message : String(e));
              finish();
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      const timeout = setTimeout(() => {
        finish();
        reject(new Error('Plaid link timed out — no bank was connected'));
      }, 10 * 60_000);

      function finish() {
        clearTimeout(timeout);
        setTimeout(() => server.close(), 1000);
        activeLink = null;
        cancelActive = null;
      }

      cancelActive = () => {
        finish();
        reject(new Error('Plaid link cancelled'));
      };

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        // 127.0.0.1, not localhost: the server listens IPv4-only, and on some
        // systems localhost resolves to ::1 first and the connection fails.
        void shell.openExternal(`http://127.0.0.1:${port}`);
      });

      server.on('error', (err) => {
        finish();
        reject(err);
      });
    })().catch((err) => {
      activeLink = null;
      cancelActive = null;
      reject(err);
    });
  });

  return activeLink;
}
