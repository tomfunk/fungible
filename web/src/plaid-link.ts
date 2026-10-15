// Web implementation of the plaid.linkBank/cancelLink bridge calls.
//
// Desktop launches a system-browser flow via a local HTTP server
// (gui/main/plaid-link.ts, built on core/plaid-link-flow.ts) because
// Electron's main process can't embed Link directly. The browser doesn't
// need any of that: this loads Plaid Link's own JS SDK — the same CDN script
// core/plaid-link-flow.ts's linkPage() already serves for the TUI/scripts
// flow, https://cdn.plaid.com/link/v2/stable/link-initialize.js — straight
// into this page and drives it with a link_token fetched from the sync server, not
// core/plaid.ts: the sync server holds the Plaid secret for logged-in web users
// (see account-client.ts's plaidClient, requires an authenticated session —
// see LoginScreen.tsx).
//
// Loaded via a plain <script> tag rather than an npm package (react-plaid-link
// or plaid's own SDK package) because adding a dependency means editing the
// root package.json, which is vassal-repo's land, not gui's.

import { plaidClient } from './account-client.js';
import { syncNow } from './account-client.js';

type PlaidSuccessMetadata = { institution?: { name: string | null } | null };
type PlaidExitMetadata = { status?: string | null };
type PlaidCreateConfig = {
  token: string;
  onSuccess: (publicToken: string, metadata: PlaidSuccessMetadata) => void;
  onExit: (err: { error_message?: string } | null, metadata: PlaidExitMetadata) => void;
};
type PlaidHandler = { open(): void; exit(opts?: { force?: boolean }): void };

declare global {
  interface Window {
    Plaid?: { create(config: PlaidCreateConfig): PlaidHandler };
  }
}

const SDK_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

let sdkPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load the Plaid Link script (cdn.plaid.com unreachable?)'));
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

let activeHandler: PlaidHandler | null = null;

/** Matches gui/shared/api-types.ts's plaid.linkBank signature (see
 *  gui/main/bridge.ts's desktop implementation) so Accounts.tsx (reused
 *  unchanged from gui/renderer/src) works without knowing which platform
 *  it's on. */
export async function linkBank(
  _daysRequested?: number,
  updateItemId?: string,
): Promise<{ institutionName: string | null }> {
  if (updateItemId) {
    // the sync server's POST /plaid/link/token has no update-mode equivalent yet
    // (no access_token-by-item lookup — see the sync server's plaid route);
    // only linking a fresh Item works today.
    throw new Error("Updating an existing link isn't supported on the web yet — remove and re-add the bank instead.");
  }

  const { link_token } = await plaidClient.linkToken();
  await loadSdk();

  return new Promise((resolve, reject) => {
    const handler = window.Plaid!.create({
      token: link_token,
      onSuccess: (publicToken, metadata) => {
        activeHandler = null;
        plaidClient
          .exchange(publicToken)
          .then(async (res) => {
            // Pull the newly linked institution's transactions immediately,
            // so the account isn't left empty until the user finds the
            // manual Sync button. Desktop's equivalent (Accounts.tsx's
            // syncNewInstitutions, run from its onLinked callback) can't do
            // this job here: it keys off a local plaid_items table this web
            // build never populates. Best-effort —
            // the *link* succeeded regardless of whether this sync did, and
            // a failure here surfaces again the next time the user hits Sync.
            try {
              await syncNow({ refreshPlaid: true });
            } catch {
              // Swallowed on purpose — see comment above.
            }
            resolve({ institutionName: res.institution_name ?? metadata.institution?.name ?? null });
          })
          .catch(reject);
      },
      onExit: (err) => {
        activeHandler = null;
        reject(err ? new Error(err.error_message ?? 'Plaid Link exited with an error') : new Error('Link canceled'));
      },
    });
    activeHandler = handler;
    handler.open();
  });
}

/** Closing the link modal while a flow is in progress abandons it — mirrors
 *  desktop's cancelActivePlaidLink (see Accounts.tsx's LinkBankModal.close). */
export async function cancelLink(): Promise<void> {
  activeHandler?.exit({ force: true });
  activeHandler = null;
}
