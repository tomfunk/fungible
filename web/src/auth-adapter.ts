// Browser AuthAdapter for core/auth-client.ts.
//
// The access token lives only in this module's memory. The refresh token is an
// httpOnly cookie JavaScript cannot read, so getRefreshToken() is always null;
// the engine is configured with credentials:'include' and refreshes by cookie.
//
// "Believed to exist" is a non-secret localStorage hint, set on login and
// cleared on logout or when a refresh is refused. Its only job is to let a
// first-time visitor skip a POST /auth/refresh that could only 400. It carries
// no token and no identity.
import type { AuthAdapter } from '../../core/auth-client.js';

export const SESSION_HINT_KEY = 'fungible.hasSession';

type HintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): HintStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked site data
  }
}

export function readSessionHint(storage: HintStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSessionHint(on: boolean, storage: HintStorage | null = defaultStorage()): void {
  try {
    if (on) storage?.setItem(SESSION_HINT_KEY, '1');
    else storage?.removeItem(SESSION_HINT_KEY);
  } catch {
    // Hint is an optimisation only.
  }
}

export function browserAuthAdapter(opts: { storage?: HintStorage | null; onClear?: () => void } = {}): AuthAdapter {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  let access: string | null = null;
  return {
    getAccessToken: () => access,
    getRefreshToken: () => null, // httpOnly cookie; the engine runs with credentials:'include'
    setTokens: (a) => {
      access = a; // the refresh token argument is deliberately dropped
      writeSessionHint(true, storage);
    },
    clear: () => {
      access = null;
      writeSessionHint(false, storage);
      opts.onClear?.();
    },
  };
}
