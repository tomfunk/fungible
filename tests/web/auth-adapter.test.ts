import { describe, it, expect } from 'vitest';
import {
  browserAuthAdapter, readSessionHint, writeSessionHint, SESSION_HINT_KEY,
} from '../../web/src/auth-adapter.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('browserAuthAdapter', () => {
  it('has no session and no refresh token on a fresh browser', () => {
    const a = browserAuthAdapter({ storage: fakeStorage() });
    expect(a.getAccessToken()).toBeNull();
    expect(a.getRefreshToken()).toBeNull();
  });

  it('keeps the access token in memory only and never persists a token', () => {
    const s = fakeStorage();
    const a = browserAuthAdapter({ storage: s });
    a.setTokens('jwt.access.token', 'real-refresh-token');
    expect(a.getAccessToken()).toBe('jwt.access.token');
    expect(a.getRefreshToken()).toBeNull(); // never held
    expect([...s.m.values()].join('|')).not.toContain('jwt.access.token');
    expect([...s.m.values()].join('|')).not.toContain('real-refresh-token');
    expect(s.m.get(SESSION_HINT_KEY)).toBe('1');
  });

  it('a hint from an earlier page load allows a refresh attempt without an access token', () => {
    const a = browserAuthAdapter({ storage: fakeStorage({ [SESSION_HINT_KEY]: '1' }) });
    expect(a.getAccessToken()).toBeNull();
    expect(a.getRefreshToken()).toBeNull();
  });

  it('clear() drops the token and the hint and notifies', () => {
    const s = fakeStorage();
    let cleared = 0;
    const a = browserAuthAdapter({ storage: s, onClear: () => cleared++ });
    a.setTokens('t', null);
    a.clear();
    expect(a.getAccessToken()).toBeNull();
    expect(a.getRefreshToken()).toBeNull();
    expect(readSessionHint(s)).toBe(false);
    expect(cleared).toBe(1);
  });

  it('works when storage is unavailable', () => {
    const a = browserAuthAdapter({ storage: null });
    a.setTokens('t', null);
    expect(a.getRefreshToken()).toBeNull();
    a.clear();
    expect(a.getRefreshToken()).toBeNull();
    expect(() => writeSessionHint(true, null)).not.toThrow();
  });

  it('tolerates a storage that throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const a = browserAuthAdapter({ storage: throwing });
    expect(() => a.setTokens('t', null)).not.toThrow();
    expect(a.getAccessToken()).toBe('t');
  });
});
