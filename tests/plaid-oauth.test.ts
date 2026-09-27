import { describe, it, expect } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveOAuthRedirect, loadLinkTls, linkRoute, createLinkServer, linkServerOrigin, linkListenErrorMessage,
} from '../core/plaid-oauth.js';

const TLS = { FUNGIBLE_LINK_TLS_CERT: '/tmp/c.pem', FUNGIBLE_LINK_TLS_KEY: '/tmp/k.pem' };
const resolve = (env: Record<string, string>) => resolveOAuthRedirect(env as NodeJS.ProcessEnv);

describe('resolveOAuthRedirect', () => {
  it('is off when unset or blank', () => {
    expect(resolve({})).toBeNull();
    expect(resolve({ PLAID_REDIRECT_URI: '  ' })).toBeNull();
  });
  it('accepts http localhost in sandbox, which is the default environment', () => {
    expect(resolve({ PLAID_REDIRECT_URI: 'http://localhost:4747/oauth-return' })).toEqual({
      uri: 'http://localhost:4747/oauth-return', pathname: '/oauth-return', port: 4747, tls: null,
    });
  });
  it('accepts https localhost in production with a certificate and key', () => {
    expect(resolve({ PLAID_ENV: 'production', PLAID_REDIRECT_URI: 'https://localhost:4747/oauth-return', ...TLS })).toEqual({
      uri: 'https://localhost:4747/oauth-return', pathname: '/oauth-return', port: 4747,
      tls: { certPath: '/tmp/c.pem', keyPath: '/tmp/k.pem' },
    });
  });
  it('trims surrounding whitespace', () => {
    expect(resolve({ PLAID_REDIRECT_URI: ' http://localhost:4747/r ' })?.uri).toBe('http://localhost:4747/r');
  });
  it.each([
    ['http://localhost:4747/r?x=1', /"\?", "#" or "\*"/],
    ['http://localhost:4747/r#x', /"\?", "#" or "\*"/],
    ['https://*.localhost:4747/r', /"\?", "#" or "\*"/],
    ['not a url', /not a valid URL/],
    ['ftp://localhost:4747/r', /http or https/],
    ['http://127.0.0.1:4747/r', /localhost/],
    ['http://example.com:4747/r', /localhost/],
    ['http://localhost/r', /explicit port/],
    ['https://localhost:443/r', /explicit port/],
    ['http://LOCALHOST:4747/r', /http:\/\/localhost:4747\/r/],
    ['http://localhost:4747', /http:\/\/localhost:4747\//],
    ['http://localhost:4747/', /own path/],
    ['http://localhost:4747/callback', /own path/],
  ])('rejects %s', (uri, msg) => {
    expect(() => resolve({ PLAID_REDIRECT_URI: uri, ...TLS })).toThrow(msg);
  });
  it('names the variable in every refusal', () => {
    expect(() => resolve({ PLAID_REDIRECT_URI: 'http://localhost/r' })).toThrow(/^PLAID_REDIRECT_URI /);
  });
  it('refuses http outside sandbox, because Plaid only allows it there', () => {
    expect(() => resolve({ PLAID_ENV: 'production', PLAID_REDIRECT_URI: 'http://localhost:4747/r' })).toThrow(/https/);
  });
  it('requires both TLS variables for https', () => {
    expect(() => resolve({ PLAID_REDIRECT_URI: 'https://localhost:4747/r', FUNGIBLE_LINK_TLS_CERT: '/tmp/c.pem' }))
      .toThrow(/FUNGIBLE_LINK_TLS_CERT and FUNGIBLE_LINK_TLS_KEY/);
  });
});

describe('loadLinkTls', () => {
  it('returns null when no TLS is configured', () => {
    expect(loadLinkTls(null)).toBeNull();
    expect(loadLinkTls(resolve({ PLAID_REDIRECT_URI: 'http://localhost:4747/r' }))).toBeNull();
  });
  it('fails with a named error when a file is missing', () => {
    const cfg = resolve({ PLAID_REDIRECT_URI: 'https://localhost:4747/r',
      FUNGIBLE_LINK_TLS_CERT: '/nonexistent/c.pem', FUNGIBLE_LINK_TLS_KEY: '/nonexistent/k.pem' });
    expect(() => loadLinkTls(cfg)).toThrow(/FUNGIBLE_LINK_TLS_CERT \/ FUNGIBLE_LINK_TLS_KEY could not be loaded/);
  });
  it('fails with a named error when the files are not a usable certificate and key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-tls-'));
    fs.writeFileSync(path.join(dir, 'c.pem'), 'not a certificate');
    fs.writeFileSync(path.join(dir, 'k.pem'), 'not a key');
    const cfg = resolve({ PLAID_REDIRECT_URI: 'https://localhost:4747/r',
      FUNGIBLE_LINK_TLS_CERT: path.join(dir, 'c.pem'), FUNGIBLE_LINK_TLS_KEY: path.join(dir, 'k.pem') });
    expect(() => loadLinkTls(cfg)).toThrow(/could not be loaded/);
  });
});

describe('linkRoute', () => {
  const cfg = resolve({ PLAID_REDIRECT_URI: 'http://localhost:4747/oauth-return' });
  it('routes the Link page and the callback as before', () => {
    expect(linkRoute('GET', '/', null)).toBe('page');
    expect(linkRoute('POST', '/callback', null)).toBe('callback');
    expect(linkRoute('GET', '/callback', null)).toBeNull();
  });
  it('routes the bank hand-back, which carries oauth_state_id', () => {
    expect(linkRoute('GET', '/oauth-return?oauth_state_id=abc', cfg)).toBe('oauth-return');
    expect(linkRoute('GET', '/oauth-return', cfg)).toBe('oauth-return');
  });
  it('ignores the return path when no redirect is configured, and other methods or paths', () => {
    expect(linkRoute('GET', '/oauth-return', null)).toBeNull();
    expect(linkRoute('POST', '/oauth-return', cfg)).toBeNull();
    expect(linkRoute('GET', '/oauth-return/', cfg)).toBeNull();
    expect(linkRoute('GET', '/favicon.ico', cfg)).toBeNull();
    expect(linkRoute('GET', undefined, cfg)).toBeNull();
  });
});

describe('createLinkServer', () => {
  it('serves plain http when there is no TLS', () => {
    const server = createLinkServer(() => {}, null);
    expect(server).toBeInstanceOf(http.Server);
    expect(server).not.toBeInstanceOf(https.Server);
  });
});

describe('linkServerOrigin', () => {
  it('uses the redirect origin when configured', () => {
    const cfg = resolve({ PLAID_ENV: 'production', PLAID_REDIRECT_URI: 'https://localhost:4747/r', ...TLS });
    expect(linkServerOrigin(cfg, 4747)).toBe('https://localhost:4747');
  });
  it('falls back to plain http on the given host and port', () => {
    expect(linkServerOrigin(null, 4747)).toBe('http://localhost:4747');
    expect(linkServerOrigin(null, 51234, '127.0.0.1')).toBe('http://127.0.0.1:51234');
  });
});

describe('linkListenErrorMessage', () => {
  const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  it('names PLAID_REDIRECT_URI when its fixed port is taken', () => {
    const cfg = resolve({ PLAID_REDIRECT_URI: 'http://localhost:4747/r' });
    expect(linkListenErrorMessage(inUse, 4747, cfg)).toMatch(/port 4747 from PLAID_REDIRECT_URI is already in use/);
  });
  it('passes other errors through', () => {
    expect(linkListenErrorMessage(inUse, 0, null)).toBe('listen EADDRINUSE');
  });
});
