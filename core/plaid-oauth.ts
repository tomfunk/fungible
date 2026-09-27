import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';

/**
 * Optional OAuth redirect for the Plaid Link flow (PLAID_REDIRECT_URI).
 *
 * On desktop, Plaid opens an OAuth bank (Chase, Amex, ...) in a popup and needs no
 * redirect URI. When a popup is not possible the whole tab goes to the bank and
 * the bank sends it back to `redirect_uri`, where Link must be re-opened with the
 * same link token and `receivedRedirectUri`. That return has to reach the local
 * link server that holds the token, so the URI must be localhost on a fixed port.
 * Plaid only accepts http://localhost in sandbox; elsewhere it must be https, which
 * the link server can serve with a user-supplied certificate (e.g. from mkcert).
 * See https://plaid.com/docs/link/oauth/
 */
export type OAuthRedirectConfig = {
  /** Sent to Plaid verbatim; must match the Dashboard allowlist exactly. */
  uri: string;
  pathname: string;
  port: number;
  tls: { certPath: string; keyPath: string } | null;
};

export type LinkTls = { cert: Buffer; key: Buffer };
export type LinkRoute = 'page' | 'oauth-return' | 'callback' | null;

const EXAMPLE = 'https://localhost:4747/oauth-return';

function refuse(why: string): never {
  throw new Error(`PLAID_REDIRECT_URI ${why}`);
}

/** Reads and validates PLAID_REDIRECT_URI. Returns null when it is not set. */
export function resolveOAuthRedirect(env: NodeJS.ProcessEnv = process.env): OAuthRedirectConfig | null {
  const raw = env.PLAID_REDIRECT_URI?.trim();
  if (!raw) return null;

  if (/[?#*]/.test(raw)) {
    refuse(`must not contain "?", "#" or "*": Plaid rejects query strings, fragments and wildcards here. Example: ${EXAMPLE}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(`is not a valid URL. Example: ${EXAMPLE}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse(`must use http or https. Example: ${EXAMPLE}`);
  if (url.hostname !== 'localhost') {
    refuse(`must point at localhost, because the bank sends you back to fungible's link server on this machine. Example: ${EXAMPLE}`);
  }
  if (url.port === '') refuse(`must include an explicit port other than 80 or 443. Example: ${EXAMPLE}`);
  const canonical = url.origin + url.pathname;
  if (raw !== canonical) {
    refuse(`must be written exactly as the browser will see it, so it matches what you register with Plaid: ${canonical}`);
  }
  if (url.pathname === '/' || url.pathname === '/callback') {
    refuse(`needs its own path (not "/" or "/callback"). Example: ${EXAMPLE}`);
  }

  const plaidEnv = env.PLAID_ENV ?? 'sandbox';
  if (url.protocol === 'http:' && plaidEnv !== 'sandbox') {
    refuse(`must use https when PLAID_ENV=${plaidEnv}: Plaid accepts http://localhost only in sandbox. Use ${EXAMPLE} with FUNGIBLE_LINK_TLS_CERT and FUNGIBLE_LINK_TLS_KEY.`);
  }

  let tls: OAuthRedirectConfig['tls'] = null;
  if (url.protocol === 'https:') {
    const certPath = env.FUNGIBLE_LINK_TLS_CERT?.trim();
    const keyPath = env.FUNGIBLE_LINK_TLS_KEY?.trim();
    if (!certPath || !keyPath) {
      refuse('uses https, so FUNGIBLE_LINK_TLS_CERT and FUNGIBLE_LINK_TLS_KEY must name a certificate and key for localhost (for example from "mkcert localhost").');
    }
    tls = { certPath, keyPath };
  }

  return { uri: raw, pathname: url.pathname, port: Number(url.port), tls };
}

/**
 * Loads the link server's certificate and key and proves they form a usable pair.
 * Hosts call this before creating a link token, so a bad file fails before Plaid
 * is contacted rather than after the user has started linking.
 */
export function loadLinkTls(cfg: OAuthRedirectConfig | null): LinkTls | null {
  if (!cfg?.tls) return null;
  try {
    const cert = readFileSync(cfg.tls.certPath);
    const key = readFileSync(cfg.tls.keyPath);
    createSecureContext({ cert, key });
    return { cert, key };
  } catch (e) {
    throw new Error(`FUNGIBLE_LINK_TLS_CERT / FUNGIBLE_LINK_TLS_KEY could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The link server's route table, shared by scripts/link.ts and the GUI. */
export function linkRoute(method: string | undefined, url: string | undefined, cfg: OAuthRedirectConfig | null): LinkRoute {
  if (!url) return null;
  if (method === 'GET' && url === '/') return 'page';
  if (method === 'POST' && url === '/callback') return 'callback';
  if (method === 'GET' && cfg) {
    // The bank appends ?oauth_state_id=..., so match on the path alone.
    let pathname: string;
    try {
      pathname = new URL(url, 'http://localhost').pathname;
    } catch {
      return null;
    }
    if (pathname === cfg.pathname) return 'oauth-return';
  }
  return null;
}

/** An https server when TLS is configured, otherwise plain http as before. */
export function createLinkServer(handler: http.RequestListener, tls: LinkTls | null): http.Server {
  return tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);
}

/** The URL to open in the browser: the redirect's origin, so the certificate and the bank's return both match. */
export function linkServerOrigin(cfg: OAuthRedirectConfig | null, port: number, host = 'localhost'): string {
  return cfg ? new URL(cfg.uri).origin : `http://${host}:${port}`;
}

/** A listen error worded for the user. A redirect pins the port, so a busy port needs explaining. */
export function linkListenErrorMessage(err: NodeJS.ErrnoException, port: number, cfg: OAuthRedirectConfig | null): string {
  if (cfg && err.code === 'EADDRINUSE') {
    return `port ${port} from PLAID_REDIRECT_URI is already in use (another fungible link still running?). Close it and try again.`;
  }
  return err.message;
}
