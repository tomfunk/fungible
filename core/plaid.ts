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
  const config = new Configuration({
    basePath: PlaidEnvironments[env as keyof typeof PlaidEnvironments],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  return new PlaidApi(config);
}

export async function createLinkToken(userId: string, daysRequested?: number) {
  const response = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'Fungible',
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
    // Omitting transactions lets Plaid apply its 90-day default
    ...(daysRequested ? { transactions: { days_requested: daysRequested } } : {}),
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
