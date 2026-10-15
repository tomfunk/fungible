// The web app's single point of contact with the sync server: auth, sync and the
// Plaid/LLM proxies.
//
// Auth and sync are NOT implemented here. They are the shared engine in
// core/auth-client.ts, core/sync-mode.ts and core/sync-client.ts (the same code
// the desktop app and TUI run); this module only configures them for a browser
// and adapts their results to what the renderer expects.
//
//   - VITE_FUNGIBLE_SYNC_URL unset/empty: the build is purely local. No Connect UI
//     (getAccountState() is null), no resume, no auth/sync requests, no default URL.
//   - The web app starts local-only (mode 'byok'): nothing here touches the
//     network until the user connects from Settings.
//   - tokens: auth-adapter.ts keeps the access token in memory and relies on
//     the sync server's httpOnly refreshToken cookie for the refresh token. The only
//     thing remembered across reloads is the non-secret localStorage hint.
//   - cookies: configureAuth(..., {credentials:'include', fetch: authFetch}).
//     authFetch feeds the connectivity banner, never lets a refresh go out
//     when there is no hint of a session, and turns a 5xx on /auth/refresh
//     into a thrown network error so "server down" is not mistaken for
//     "session revoked" (the engine drops the session on any non-ok refresh).
//
// Server routes used here (not by the engine): POST /plaid/link/token,
// POST /plaid/link/exchange, GET /plaid/items, DELETE /plaid/items/:id,
// POST /llm/anthropic|openai, POST /auth/logout, POST /sync (Plaid -> the sync server).
import {
  configureAuth, getAccessToken, refresh, logout as coreLogout, sessionEmail, AuthError,
} from '../../core/auth-client.js';
import { connectAccount, disableHostedMode, getSyncMode, SyncError } from '../../core/sync-mode.js';
import { configureSync, runSyncCycle, getSyncInfo, type CycleStats } from '../../core/sync-client.js';
import { isPersistent, resetBrowserDb } from '../../core/db.browser.js';
import { notifyChange } from '../../core/refresh.js';
import { describeError } from '../../gui/shared/account-types.js';
import type {
  AccountState, ConnectOptions, ConnectResult, CycleSummary, EraseResult,
} from '../../gui/shared/account-types.js';
import { browserAuthAdapter, readSessionHint } from './auth-adapter.js';

/** The sync server this build talks to, or null when VITE_FUNGIBLE_SYNC_URL is
 *  unset/empty: the web app is then purely local (no Connect UI, no auth or sync
 *  requests, no default URL). */
export const BASE_URL: string | null = (import.meta.env.VITE_FUNGIBLE_SYNC_URL ?? '').trim().replace(/\/+$/, '') || null;

/** True when this build has a sync server to connect to. */
export function isSyncConfigured(): boolean {
  return BASE_URL !== null;
}

// ─── Connectivity state ─────────────────────────────────────────────────────
// 'unreachable': network failure or 5xx. 'error': the server answered but a
// sync cycle failed for another reason (rejected writes, account mismatch,
// expired session). Neither logs the user out.
export type ConnState = 'ok' | 'unreachable' | 'error';
let connState: ConnState = 'ok';
let connDetail: string | null = null;
const connListeners = new Set<(state: ConnState) => void>();

export function setConnState(state: ConnState, detail: string | null = null): void {
  if (state === connState && detail === connDetail) return;
  connState = state;
  connDetail = state === 'error' ? detail : null;
  for (const l of connListeners) l(state);
}

export function getConnState(): ConnState {
  return connState;
}

export function getConnDetail(): string | null {
  return connDetail;
}

/** Calls `listener` immediately with the current state, then on every change. */
export function subscribeConnState(listener: (state: ConnState) => void): () => void {
  connListeners.add(listener);
  listener(connState);
  return () => connListeners.delete(listener);
}

// ─── Engine configuration ───────────────────────────────────────────────────
/** fetch for every call the engine makes (auth and sync). */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isRefresh = url.includes('/auth/refresh');
  // No hint and no access token means there is no session to refresh: do not
  // make a request that could only fail. The engine reads a non-ok refresh as
  // "no session" and returns null.
  if (isRefresh && !hasSession()) {
    return new Response(JSON.stringify({ error: 'no_session' }), { status: 401 });
  }
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    setConnState('unreachable');
    throw err;
  }
  if (res.status >= 500) {
    setConnState('unreachable');
    if (isRefresh) throw new TypeError('sync server unreachable');
  } else if (connState === 'unreachable') {
    setConnState('ok');
  }
  return res;
}

const adapter = browserAuthAdapter();
let configured = false;
/** Idempotent. Called at module load; exported for tests that stub fetch first. */
export function configureWebEngine(): void {
  if (configured) return;
  if (BASE_URL === null) return;
  configured = true;
  configureAuth(adapter, BASE_URL, { fetch: authFetch, credentials: 'include' });
  configureSync(BASE_URL, { fetch: authFetch });
}
configureWebEngine();

// ─── Session ────────────────────────────────────────────────────────────────

/** Email/plan claims of the held access token (decoded, never verified). */
export function sessionInfo(): { email: string; isPaid: boolean } | null {
  const token = adapter.getAccessToken();
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { email?: unknown; isPaid?: unknown };
    if (typeof claims.email !== 'string' || typeof claims.isPaid !== 'boolean') return null;
    return { email: claims.email, isPaid: claims.isPaid };
  } catch {
    return null;
  }
}

/** A session is held, or believed to exist (the localStorage hint). */
export function hasSession(): boolean {
  return adapter.getAccessToken() !== null || readSessionHint();
}

/** This install syncs and has a session: the only state in which the
 *  server-backed features (Plaid, the LLM proxy) can be used. */
export async function isConnected(): Promise<boolean> {
  if (!isSyncConfigured()) return false;
  return (await getSyncMode()) === 'hosted' && hasSession();
}

export type ResumeResult = 'resumed' | 'none' | 'offline';

/** Boot-time silent resume. Makes no request at all when this browser has never
 *  logged in (no hint). 'offline' means a session probably exists but the
 *  server could not be reached: boot the shell from local data, keep the hint. */
export async function resumeSession(): Promise<ResumeResult> {
  if (!isSyncConfigured()) return 'none';
  if (adapter.getAccessToken()) return 'resumed';
  if (!readSessionHint()) return 'none';
  try {
    return (await getAccessToken()) ? 'resumed' : 'none';
  } catch {
    return 'offline';
  }
}

const FRIENDLY: Record<string, string> = {
  not_authenticated: 'Your session has ended. Sign in again.',
  account_mismatch: 'This browser holds data from a different account.',
};

/** Connect this browser to an account: login/register, bind the database
 *  (no file snapshot: the browser DB has none), then the first cycle (auto pull)
 *  and the background timer. Throws AuthError for bad credentials. */
export async function connect(email: string, password: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  if (!isSyncConfigured()) throw new Error('Sync is not configured (VITE_FUNGIBLE_SYNC_URL is not set).');
  try {
    await connectAccount(email.trim(), password, {
      createAccount: !!opts.createAccount,
      resetForNewAccount: !!opts.resetForNewAccount,
      snapshot: false,
    });
  } catch (e) {
    if (e instanceof SyncError && e.code === 'account_mismatch') return { status: 'account_mismatch' };
    throw e;
  }
  setConnState('ok');
  const results = await syncNow();
  const first = results[0];
  startBackgroundCycles();
  return {
    status: 'connected',
    summary: first?.cycle ?? { pushed: 0, pulled: 0, superseded: 0, retrying: 0, held: 0, rejected: 0, clockSkew: false },
  };
}

async function postLogout(): Promise<void> {
  if (BASE_URL === null) return;
  try {
    await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Local state is cleared regardless; the server row/cookie may outlive it.
  }
}

/** Plain sign out. Local data is kept, sync is switched off. One last cycle
 *  first, best effort, so edits are not stranded behind the sign-out. */
export async function signOut(): Promise<void> {
  stopBackgroundCycles();
  try {
    if (await getSyncMode() === 'hosted' && hasSession()) await runSyncCycle();
  } catch {
    // Offline or expired: the queued edits stay in the local op log and push on
    // the next sign-in.
  }
  await disableHostedMode();
  coreLogout();
  setConnState('ok');
  await postLogout();
}

/** Sign out AND delete this browser's copy. Goes ahead only when a final cycle
 *  ran clean and nothing is pending, held or rejected; otherwise keeps the data
 *  and says why. */
export async function signOutAndErase(): Promise<EraseResult> {
  stopBackgroundCycles();
  const keep = (reason: string): EraseResult => {
    if (hasSession() && connState !== 'error') startBackgroundCycles();
    return { erased: false, reason };
  };
  let stats: CycleStats;
  try {
    stats = await runSyncCycle();
  } catch (err) {
    const text = describeFailure(err).text;
    return keep(`Could not finish syncing (${text}). Your data was kept on this device.`);
  }
  const info = await getSyncInfo();
  const blockers: string[] = [];
  if (stats.errors.length + info.rejectedCount > 0) blockers.push('some changes were rejected by the server');
  if (info.pendingCount > 0) blockers.push(`${info.pendingCount} change${info.pendingCount === 1 ? ' has' : 's have'} not synced yet`);
  if (info.heldCount > 0) blockers.push(`${info.heldCount} change${info.heldCount === 1 ? ' is' : 's are'} waiting on other data`);
  if ((stats.retrying ?? 0) > 0) blockers.push('some changes are still being retried');
  if (stats.clockSkew) blockers.push("this device's clock looks wrong");
  if (blockers.length > 0) {
    return keep(`Your data was kept on this device because ${blockers.join(', ')}.`);
  }
  coreLogout();
  await postLogout();
  await resetBrowserDb();
  return { erased: true };
}

/** Wipe the stored database without signing out of anything (account-mismatch
 *  choice). The caller reloads so the app reopens clean. */
export async function eraseLocalData(): Promise<void> {
  stopBackgroundCycles();
  coreLogout();
  await resetBrowserDb();
}

/** null when this build has no sync server configured: Settings renders no
 *  Account section at all (same contract as the desktop app without FUNGIBLE_SYNC_URL). */
export async function getAccountState(): Promise<AccountState | null> {
  if (!isSyncConfigured()) return null;
  const info = await getSyncInfo();
  return {
    platform: 'web',
    mode: info.mode,
    signedIn: info.mode === 'hosted' && hasSession(),
    email: sessionEmail() ?? sessionInfo()?.email ?? null,
    lastSyncAt: info.lastSyncAt,
    pendingCount: info.pendingCount,
    heldCount: info.heldCount,
    rejectedCount: info.rejectedCount,
    persistent: isPersistent(),
  };
}

export { AuthError, SyncError };

// ─── Requests ───────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
type RequestOpts = Omit<RequestInit, 'body'> & { json?: Json };

async function request<T>(path: string, init: RequestOpts = {}, retried = false): Promise<T> {
  if (BASE_URL === null) throw new Error('Sync is not configured (VITE_FUNGIBLE_SYNC_URL is not set).');
  const { json, headers, ...rest } = init;
  const access = await getAccessToken().catch(() => adapter.getAccessToken());
  const res = await authFetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(access ? { authorization: `Bearer ${access}` } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (res.status === 401 && !retried) {
    const renewed = await refresh().catch(() => null);
    if (renewed) return request<T>(path, init, true);
  }
  if (!res.ok) {
    const body: { error?: string } = await res.json().catch(() => ({}));
    throw new Error(`sync server ${path} -> ${res.status}: ${body.error ?? res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const plaidClient = {
  isConfigured: (): Promise<boolean> => isConnected(),
  linkToken: () => request<{ link_token: string; expiration: string }>('/plaid/link/token', { method: 'POST' }),
  exchange: (publicToken: string) =>
    request<{ id: string; item_id: string; institution_name: string | null }>('/plaid/link/exchange', {
      method: 'POST',
      json: { public_token: publicToken },
    }),
  listItems: () =>
    request<{
      items: { id: string; item_id: string; institution_name: string | null; last_synced_at: string | null; created_at: string }[];
    }>('/plaid/items'),
  deleteItem: (itemId: string) => request<{ ok: true }>(`/plaid/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
};

// ─── Sync (engine: core/sync-client.ts) ─────────────────────────────────────

/** Same shape as core/sync.ts's SyncItemResult, plus the cycle summary under
 *  `cycle` for the renderer's notes (merged edits, waiting, rejected, clock). */
export type WebSyncResult = {
  itemId: string;
  added: number;
  modified: number;
  removed: number;
  dupes: number;
  skipped: boolean;
  error?: string;
  cycle?: CycleSummary;
};

function describeFailure(err: unknown): { text: string; network: boolean } {
  if (err instanceof SyncError) return { text: FRIENDLY[err.code] ?? `Sync error (${err.code})`, network: false };
  if (err instanceof AuthError) return { text: FRIENDLY[err.code] ?? `Auth error (${err.code})`, network: false };
  const d = describeError(err);
  return { text: d.message, network: err instanceof TypeError || d.network };
}

export function summarizeCycle(stats: CycleStats, held = 0): CycleSummary {
  return {
    pushed: stats.pushed,
    pulled: stats.pullApplied,
    superseded: stats.superseded,
    retrying: stats.retrying ?? 0,
    held,
    rejected: stats.errors.length,
    clockSkew: stats.clockSkew === true,
  };
}

export function cycleToResults(stats: CycleStats, held = 0): WebSyncResult[] {
  return [{
    itemId: 'hosted',
    added: stats.pullApplied,
    modified: 0,
    removed: 0,
    dupes: stats.pullSkipped,
    skipped: stats.inert === 'byok',
    cycle: summarizeCycle(stats, held),
  }];
}

function failureResult(err: unknown): WebSyncResult {
  const { text, network } = describeFailure(err);
  setConnState(network ? 'unreachable' : 'error', text);
  return { itemId: 'hosted', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: text };
}

/** One push+pull cycle through the engine. Never throws; failures come back as
 *  a result carrying `error` and update the connection banner. With
 *  `refreshPlaid`, first asks the sync server to pull fresh data from Plaid. */
export async function syncNow(opts: { refreshPlaid?: boolean } = {}): Promise<WebSyncResult[]> {
  if (!isSyncConfigured()) return [{ itemId: 'hosted', added: 0, modified: 0, removed: 0, dupes: 0, skipped: true }];
  // Local-only installs have no server-side Plaid to refresh.
  if (opts.refreshPlaid && (await getSyncMode()) === 'hosted') {
    try {
      await request<unknown>('/sync', { method: 'POST' });
    } catch (err) {
      return [failureResult(err)];
    }
  }
  try {
    const stats = await runSyncCycle();
    if (connState === 'error') setConnState('ok');
    const held = stats.inert ? 0 : (await getSyncInfo()).heldCount;
    if (stats.pullApplied > 0 || stats.byokAdopted) notifyChange();
    return cycleToResults(stats, held);
  } catch (err) {
    return [failureResult(err)];
  }
}

export function getWebSyncInfo() {
  return getSyncInfo();
}

const BACKGROUND_INTERVAL_MS = 2 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

async function backgroundTick(): Promise<void> {
  if (!isSyncConfigured()) return;
  // Never a request without a session, and nothing in local-only mode.
  if (!hasSession() || (await getSyncMode()) !== 'hosted') return;
  await syncNow();
}

/** Background interval only (the caller runs the immediate cycle). */
export function startBackgroundCycles(intervalMs: number = BACKGROUND_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => void backgroundTick(), intervalMs);
}

/** Boot/resume: auto pull right away plus the interval, only when this install
 *  syncs and a session exists. Fire and forget; never blocks the UI shell. */
export async function startSyncSession(intervalMs: number = BACKGROUND_INTERVAL_MS): Promise<void> {
  if (!isSyncConfigured()) return;
  if ((await getSyncMode()) !== 'hosted' || !hasSession()) return;
  startBackgroundCycles(intervalMs);
  await syncNow();
}

export function stopBackgroundCycles(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ─── LLM proxy (SSE parsing and the chat loop live in agent-llm.ts) ─────────
// the sync server's POST /llm/:provider is a byte-for-byte passthrough with its own
// key injected. Errors come back as either sync server control errors
// ({ error: '<code>' }: 402 paid_tier_required, 429 usage_cap_exceeded, 503
// *_not_configured) or the upstream provider's own body ({ error: {...} }).
// extractErrorCode() normalises both to one string code.
export type LlmProvider = 'anthropic' | 'openai';

export class LlmProxyError extends Error {
  constructor(public status: number, public code: string) {
    super(`sync server /llm proxy -> ${status}: ${code}`);
  }
}

function extractErrorCode(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const { error } = parsed as { error?: unknown };
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const inner = error as Record<string, unknown>;
    return (inner.code as string) ?? (inner.type as string) ?? (inner.message as string) ?? null;
  }
  return null;
}

/** POSTs `body` to /llm/:provider and returns the raw Response (JSON or an SSE
 *  stream). Throws LlmProxyError on non-2xx, after one refresh-and-retry on 401. */
export async function llmRequest(provider: LlmProvider, body: Json, retried = false): Promise<Response> {
  if (BASE_URL === null) throw new Error('Sync is not configured (VITE_FUNGIBLE_SYNC_URL is not set).');
  const access = await getAccessToken().catch(() => adapter.getAccessToken());
  const res = await authFetch(`${BASE_URL}/llm/${provider}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(access ? { authorization: `Bearer ${access}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !retried) {
    const renewed = await refresh().catch(() => null);
    if (renewed) return llmRequest(provider, body, true);
  }
  if (!res.ok) {
    const parsed: unknown = await res.json().catch(() => null);
    throw new LlmProxyError(res.status, extractErrorCode(parsed) ?? String(res.status));
  }
  return res;
}

export function currentAccessToken(): string | null {
  return adapter.getAccessToken();
}
