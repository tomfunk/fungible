import { describe, it, expect, vi, afterEach } from 'vitest';
import { configureAuth, login, register, refresh, memoryAuthAdapter } from '../core/auth-client.js';

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('configureAuth options', () => {
  it('passes credentials and uses the injected fetch for login/register/refresh', async () => {
    const f = vi.fn(async () => jsonRes({ accessToken: 'a', refreshToken: 'r' }));
    configureAuth(memoryAuthAdapter({ refresh: 'r0' }), 'http://x/', { fetch: f as unknown as typeof fetch, credentials: 'include' });
    await login('e', 'p');
    await register('e', 'p');
    await refresh();
    expect(f).toHaveBeenCalledTimes(3);
    for (const call of f.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].credentials).toBe('include');
    }
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://x/auth/login');
  });

  it('cookie session refreshes without a stored token and sends an empty body', async () => {
    const f = vi.fn(async () => jsonRes({ accessToken: 'newacc' }));
    const adapter = memoryAuthAdapter();
    configureAuth(adapter, 'http://x', { fetch: f as unknown as typeof fetch, credentials: 'include' });
    expect(await refresh()).toBe('newacc');
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({});
    expect(adapter.getAccessToken()).toBe('newacc');
  });

  it('a failed cookie refresh clears the adapter and returns null', async () => {
    const f = vi.fn(async () => jsonRes({}, false, 401));
    const adapter = memoryAuthAdapter({ access: 'old' });
    configureAuth(adapter, 'http://x', { fetch: f as unknown as typeof fetch, credentials: 'include' });
    expect(await refresh()).toBeNull();
    expect(adapter.getAccessToken()).toBeNull();
  });

  it('default (Node) behaviour is unchanged: no token means no request, no credentials key', async () => {
    const g = vi.fn(async () => jsonRes({ accessToken: 'a', refreshToken: 'r' }));
    vi.stubGlobal('fetch', g);
    configureAuth(memoryAuthAdapter(), 'http://x');
    expect(await refresh()).toBeNull();
    expect(g).not.toHaveBeenCalled();
    await login('e', 'p');
    expect('credentials' in (g.mock.calls[0] as unknown as [string, RequestInit])[1]).toBe(false);
  });
});
