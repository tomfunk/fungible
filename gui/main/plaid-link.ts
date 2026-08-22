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

type LinkParams = { daysRequested?: number; updateItemId?: string };

let activeLink: Promise<{ institutionName: string | null; updateMode: boolean }> | null = null;
// The parameters `activeLink` was started with. Load-bearing: coalescing onto an
// in-flight flow is only safe when the new call means the same thing.
let activeParams: LinkParams | null = null;
let cancelActive: (() => void) | null = null;

const MAX_CALLBACK_BODY = 1_000_000;

const sameFlow = (a: LinkParams, b: LinkParams) =>
  a.updateItemId === b.updateItemId && a.daysRequested === b.daysRequested;

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
 *
 * Only one flow runs at a time. A repeat of the flow already running (a double
 * click) rides along on it; a *different* flow is refused rather than silently
 * handed the wrong promise — returning an add-mode flow to an update-mode caller
 * would exchange the public token with no `updateItemId`, creating a second Item
 * and duplicating every account and transaction on the connection the user was
 * trying to repair.
 */
export function runPlaidLink(
  daysRequested?: number,
  updateItemId?: string,
): Promise<{ institutionName: string | null; updateMode: boolean }> {
  const params: LinkParams = { daysRequested, updateItemId };
  if (activeLink) {
    if (activeParams && sameFlow(activeParams, params)) return activeLink;
    return Promise.reject(new Error(
      'Another bank connection is already in progress — finish it in your browser, or close that dialog, before starting this one.',
    ));
  }
  if (!isPlaidConfigured()) {
    return Promise.reject(new Error('Plaid is not configured — set PLAID_CLIENT_ID and PLAID_SECRET in ~/.fungible/.env'));
  }

  // Set before the executor runs, so the `finish`/`catch` teardown below always
  // clears a value that was already there rather than racing this assignment.
  activeParams = params;
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
        activeParams = null;
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
      activeParams = null;
      cancelActive = null;
      reject(err);
    });
  });

  return activeLink;
}
