import { db } from './db.js';
import { createLinkToken, exchangePublicToken } from './plaid.js';
import { encryptToken, decryptToken } from './crypto.js';
import { MIN_DAYS_REQUESTED, MAX_DAYS_REQUESTED } from './settings.js';

/**
 * The parts of the Plaid Link flow that are identical everywhere: the browser
 * pages, the link_token request, and what to persist when the user finishes.
 *
 * Only the transport differs between hosts — `scripts/link.ts` runs a fixed-port
 * server and reports progress on stdout for the TUI to parse, while
 * `gui/main/plaid-link.ts` uses an ephemeral port, a timeout and a cancel hook.
 * Those stay with their callers; everything below is shared so the two can't
 * drift apart on the details that actually matter.
 */

/** Clamp a requested history window to Plaid's accepted bounds. */
export function clampDaysRequested(days: number): number {
  return Math.max(MIN_DAYS_REQUESTED, Math.min(MAX_DAYS_REQUESTED, Math.round(days)));
}

export type LinkFlowOptions = {
  /**
   * Update the credentials on an existing connection rather than add a new one.
   * Puts Link in update mode, which keeps the Item's accounts and transactions
   * instead of creating duplicates under a fresh Item.
   */
  updateItemId?: string;
  /** History window for a new Item. Ignored in update mode — see createLinkToken. */
  daysRequested?: number;
};

/**
 * Creates the link_token for a flow, resolving the stored access token first
 * when this is an update. Throws if the item to update isn't in the database.
 */
export async function createFlowLinkToken(opts: LinkFlowOptions = {}): Promise<string> {
  const { updateItemId, daysRequested } = opts;
  let accessToken: string | undefined;

  if (updateItemId) {
    const res = await db.execute({
      sql: 'SELECT access_token FROM plaid_items WHERE item_id = ?',
      args: [updateItemId],
    });
    if (res.rows.length === 0) throw new Error(`No linked institution found for item ${updateItemId}`);
    accessToken = decryptToken((res.rows[0] as unknown as { access_token: string }).access_token);
  }

  return createLinkToken('local-user', daysRequested, accessToken);
}

export type LinkCallbackResult = {
  itemId: string;
  institutionName: string | null;
  /** True when this re-authorized an existing Item rather than adding one. */
  updateMode: boolean;
};

/**
 * Handles the JSON body Link posts back on success: exchanges the public token
 * and stores the Item, or — in update mode — does neither.
 *
 * Update mode leaves the access_token and item_id unchanged, so Plaid says the
 * exchange need not be repeated. Skipping the write matters for a second reason:
 * update mode must omit days_requested, so re-running the upsert would blank the
 * stored history window of a perfectly good Item.
 */
export async function completeLink(body: string, opts: LinkFlowOptions = {}): Promise<LinkCallbackResult> {
  const { updateItemId, daysRequested } = opts;
  const { public_token, institution } = JSON.parse(body);
  const institutionName: string | null = institution?.name ?? null;

  if (updateItemId) {
    return { itemId: updateItemId, institutionName, updateMode: true };
  }

  const { accessToken, itemId } = await exchangePublicToken(public_token);
  await db.execute({
    sql: `INSERT INTO plaid_items (item_id, access_token, institution_name, days_requested)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET access_token=excluded.access_token, institution_name=excluded.institution_name, days_requested=excluded.days_requested`,
    args: [itemId, encryptToken(accessToken), institutionName, daysRequested ?? null],
  });
  return { itemId, institutionName, updateMode: false };
}

/** The page that hosts Plaid Link itself, served at the flow's root URL. */
export function linkPage(linkToken: string, opts: { updateMode?: boolean } = {}): string {
  const updateMode = !!opts.updateMode;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Fungible — ${updateMode ? 'Update Link' : 'Connect Bank'}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 40px; text-align: center; max-width: 380px; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; color: #fff; }
    p { color: #888; font-size: 0.9rem; margin-bottom: 28px; }
    button { background: #00d4aa; color: #000; border: none; border-radius: 8px; padding: 12px 28px; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #00bfa0; }
    .status { margin-top: 20px; font-size: 0.85rem; color: #888; }
    .success { color: #00d4aa; }
    .error { color: #ff6b6b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>fungible</h1>
    <p>${updateMode
      ? 'Sign in again to update the credentials for this link. Your existing accounts and transactions are kept.'
      : 'Connect your bank account to start tracking expenses.'}</p>
    <button id="connect-btn">${updateMode ? 'Update Credentials' : 'Connect Bank'}</button>
    <div class="status" id="status"></div>
  </div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const btn = document.getElementById('connect-btn');
    const status = document.getElementById('status');

    btn.addEventListener('click', () => {
      const handler = Plaid.create({
        token: '${linkToken}',
        onSuccess: async (publicToken, metadata) => {
          btn.disabled = true;
          status.textContent = '${updateMode ? 'Updating' : 'Connecting'}...';
          try {
            const res = await fetch('/callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: publicToken, institution: metadata.institution }),
            });
            if (res.ok) {
              status.className = 'status success';
              status.textContent = '${updateMode ? 'Link updated' : 'Connected'}! You can close this window.';
              btn.textContent = 'Done';
            } else {
              throw new Error(await res.text());
            }
          } catch (e) {
            status.className = 'status error';
            status.textContent = 'Error: ' + e.message;
            btn.disabled = false;
          }
        },
        onExit: (err) => {
          if (err) {
            status.className = 'status error';
            status.textContent = err.display_message || 'Exited without connecting.';
          }
        },
      });
      handler.open();
    });
  </script>
</body>
</html>`;
}

/** Confirmation page served once the callback has been handled. */
export function successPage(opts: { updateMode?: boolean; returnTo: string }): string {
  const updateMode = !!opts.updateMode;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${updateMode ? 'Link updated' : 'Connected'}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 40px; text-align: center; }
    h1 { color: #00d4aa; margin-bottom: 8px; }
    p { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${updateMode ? 'Link updated!' : 'Connected!'}</h1>
    <p>You can close this window and return to ${opts.returnTo}.</p>
  </div>
</body>
</html>`;
}
