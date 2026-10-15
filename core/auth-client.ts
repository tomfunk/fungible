// Portable: no node:* imports, no Buffer. The ~/.fungible/.env token adapter
// lives in core/auth-env-file.ts (Node only).

export interface AuthAdapter {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(access: string, refresh: string | null): void;
  clear(): void;
}

// base64url -> UTF-8 string using only web-standard globals (atob/TextDecoder).
function decodeJwtPayload(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

let _adapter: AuthAdapter | null = null;
let _baseUrl: string | null = null;

export interface AuthOptions {
  /** fetch implementation for login/register/refresh. Default: global fetch. */
  fetch?: typeof fetch;
  /**
   * Passed to every auth request. 'include' means the session lives in an
   * httpOnly cookie: refresh() then proceeds without a stored refresh token.
   * Default: unset (Node behaviour unchanged).
   */
  credentials?: RequestCredentials;
}

let _opts: AuthOptions = {};

export function configureAuth(adapter: AuthAdapter, baseUrl: string, opts: AuthOptions = {}): void {
  _adapter = adapter;
  _baseUrl = baseUrl.replace(/\/+$/, '');
  _opts = opts;
}

function authFetch(url: string, init: RequestInit): Promise<Response> {
  const f = _opts.fetch ?? fetch;
  return f(url, _opts.credentials ? { ...init, credentials: _opts.credentials } : init);
}

function need(): { adapter: AuthAdapter; baseUrl: string } {
  if (!_adapter || !_baseUrl) throw new Error('auth-client not configured: call configureAuth() first');
  return { adapter: _adapter, baseUrl: _baseUrl };
}

export function isAuthConfigured(): boolean {
  return _adapter != null && _baseUrl != null;
}

/** Email of the logged-in user (from the cached access token), or null. */
export function sessionEmail(): string | null {
  if (!_adapter) return null;
  const token = _adapter.getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(decodeJwtPayload(token.split('.')[1]));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** Account user id (JWT `sub`) of the current session, refreshing if needed. Null if not logged in. */
export async function sessionUserId(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(decodeJwtPayload(token.split('.')[1]));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** True when a refresh token exists — a session that can (re)authenticate. */
export function hasSession(): boolean {
  return _adapter?.getRefreshToken() != null;
}

export class AuthError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = 'AuthError';
  }
}

function jwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeJwtPayload(parts[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function expiringSoon(token: string, leewaySec = 60): boolean {
  const exp = jwtExp(token);
  if (exp == null) return true;
  return Date.now() / 1000 > exp - leewaySec;
}

/** Returns a non-expired access token, refreshing if needed. Null if not logged in. */
export async function getAccessToken(): Promise<string | null> {
  const { adapter } = need();
  const current = adapter.getAccessToken();
  if (current && !expiringSoon(current)) return current;
  return await refresh();
}

export async function login(email: string, password: string): Promise<void> {
  const { adapter, baseUrl } = need();
  const res = await authFetch(`${baseUrl}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; refreshToken?: string; error?: string };
  if (!res.ok || !body.accessToken) throw new AuthError(body.error ?? 'login_failed', res.status);
  adapter.setTokens(body.accessToken, body.refreshToken ?? null);
}

export async function register(email: string, password: string): Promise<void> {
  const { adapter, baseUrl } = need();
  const res = await authFetch(`${baseUrl}/auth/register`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; refreshToken?: string; error?: string };
  if (!res.ok || !body.accessToken) throw new AuthError(body.error ?? 'register_failed', res.status);
  adapter.setTokens(body.accessToken, body.refreshToken ?? null);
}

export async function refresh(): Promise<string | null> {
  const { adapter, baseUrl } = need();
  const refreshToken = adapter.getRefreshToken();
  // Cookie-based sessions have no readable refresh token; the browser sends
  // the httpOnly cookie when credentials === 'include'.
  if (!refreshToken && _opts.credentials !== 'include') return null;
  const res = await authFetch(`${baseUrl}/auth/refresh`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(refreshToken ? { refreshToken } : {}),
  });
  if (!res.ok) {
    adapter.clear();
    return null;
  }
  const { accessToken } = (await res.json()) as { accessToken: string };
  adapter.setTokens(accessToken, refreshToken);
  return accessToken;
}

export function logout(): void {
  const { adapter } = need();
  adapter.clear();
}

/** Adapter for tests + the web app's in-memory JWT (refresh token lives in httpOnly cookie). */
export function memoryAuthAdapter(initial: { access?: string; refresh?: string } = {}): AuthAdapter {
  let access: string | null = initial.access ?? null;
  let refresh: string | null = initial.refresh ?? null;
  return {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    setTokens: (a, r) => { access = a; if (r !== null) refresh = r; },
    clear: () => { access = null; refresh = null; },
  };
}
