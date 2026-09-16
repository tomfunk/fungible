import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

export function isPlaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function getPlaidClient(): PlaidApi {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to your .env file.');
  }
  const env = process.env.PLAID_ENV ?? 'sandbox';
  const basePath = PlaidEnvironments[env as keyof typeof PlaidEnvironments];
  if (!basePath) {
    // Plaid retired the "development" tier. Anyone whose linking appeared to work on
    // that value was silently reaching production (the SDK's default basePath), so
    // point them at production rather than letting them downgrade to sandbox data.
    const hint =
      env === 'development'
        ? ' Plaid retired the "development" tier. If your bank connection was working before, you were reaching Plaid production — set PLAID_ENV=production to keep that access. Use "sandbox" only for test data.'
        : '';
    throw new Error(
      `PLAID_ENV="${env}" is not a valid Plaid environment. Valid values: ${Object.keys(PlaidEnvironments).join(', ')}.${hint}`
    );
  }
  const config = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  return new PlaidApi(config);
}

/**
 * Creates a link_token for the Link flow.
 *
 * Passing `accessToken` puts Link in *update mode*, which re-authorizes an
 * existing Item in place. This is the difference between updating a connection
 * and replacing it: update mode keeps the Item's `item_id`, `account_id`s and
 * `transaction_id`s, so nothing downstream sees new accounts or duplicate
 * transactions. Creating a link_token without it always mints a brand-new Item,
 * even when the user re-authenticates at the same bank.
 *
 * Update mode forbids `products` and every product-specific parameter, which
 * includes `transactions.days_requested` — so `daysRequested` is ignored when
 * updating. That window is fixed when the Item is created and cannot be
 * widened later. See https://plaid.com/docs/link/update-mode/
 *
 * `update.account_selection_enabled` is what makes the update actually able to
 * *repair* a connection rather than only re-type its password. Plain update mode
 * re-authorizes credentials and nothing else, so an Item whose accounts have gone
 * away — Plaid reports `NO_ACCOUNTS`, typically after the institution renumbers
 * an account or the user's earlier Account Select choice stops matching anything
 * — fails the same way after every "update link" press. Enabling Account Select
 * re-presents the account picker, which is the only in-app path back. OAuth
 * institutions in the US always show their own picker regardless of this flag;
 * the ones that need it are the non-OAuth institutions, where without it the
 * button is a no-op for exactly the failure it looks like it should fix.
 */
export async function createLinkToken(userId: string, daysRequested?: number, accessToken?: string) {
  const response = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Fungible',
    country_codes: [CountryCode.Us],
    language: 'en',
    ...(accessToken
      ? { access_token: accessToken, update: { account_selection_enabled: true } }
      : {
          products: [Products.Transactions],
          // Omitting transactions lets Plaid apply its 90-day default
          ...(daysRequested ? { transactions: { days_requested: daysRequested } } : {}),
        }),
  });
  return response.data.link_token;
}

/**
 * Extract a human-readable message from a rejected Plaid request. The Plaid SDK
 * rejects with an Axios error whose useful payload lives at `err.response.data`
 * ({ error_type, error_code, error_message, display_message }); the bare
 * `err.message` is only "Request failed with status code 400". Prefer Plaid's
 * user-facing `display_message`, fall back to `error_code: error_message`, then
 * to the generic error message.
 */
export function plaidErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: Record<string, string> } })?.response?.data;
  if (data?.error_code) {
    return data.display_message || `${data.error_code}: ${data.error_message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function exchangePublicToken(publicToken: string) {
  const response = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}
