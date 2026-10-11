import { describe, it, expect } from 'vitest';
import {
  bearerMatches,
  checkRequestOrigin,
  isJsonContentType,
  isLocalHost,
} from '../core/http-guard.js';

describe('isLocalHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.255.255.254', true],
    ['localhost', true],
    ['LocalHost', true],
    ['localhost.', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.5', false],
    ['10.0.0.1', false],
    ['example.com', false],
    ['127.evil.com', false],
    ['127.0.0.1.evil.com', false],
    ['localhost.evil.com', false],
    ['128.0.0.1', false],
    ['', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLocalHost(host)).toBe(expected);
  });
});

describe('checkRequestOrigin', () => {
  it.each([
    ['localhost', undefined],
    ['localhost:3456', undefined],
    ['LOCALHOST:3456', undefined],
    ['localhost.:3456', undefined],
    ['127.0.0.1:3741', undefined],
    ['[::1]:3456', undefined],
    ['[::1]', undefined],
    ['localhost:3456', 'http://localhost:5173'],
    ['localhost:3456', 'https://127.0.0.1'],
    ['localhost:3456', 'http://[::1]:8080'],
    ['localhost:3456', 'HTTP://LOCALHOST:5173'],
  ])('allows Host %s Origin %s', (host, origin) => {
    expect(checkRequestOrigin({ host, ...(origin ? { origin } : {}) })).toEqual({ ok: true });
  });

  it.each([
    [undefined, undefined, 'missing Host'],
    ['', undefined, 'empty Host'],
    ['attacker.example', undefined, 'foreign Host'],
    ['attacker.example:3456', undefined, 'foreign Host with port'],
    ['localhost.evil.com', undefined, 'localhost prefix'],
    ['127.0.0.1.evil.com', undefined, 'IPv4 prefix'],
    ['127.evil.com', undefined, '127 prefix'],
    ['evil.com@localhost', undefined, 'userinfo trick'],
    ['localhost/evil.com', undefined, 'path trick'],
    ['localhost:abc', undefined, 'bad port'],
    ['0.0.0.0:3456', undefined, 'wildcard Host'],
    ['192.168.1.5', undefined, 'LAN Host'],
    ['localhost', 'null', 'opaque Origin'],
    ['localhost', 'not a url', 'malformed Origin'],
    ['localhost', 'http://evil.example', 'foreign Origin'],
    ['localhost', 'http://localhost.evil.example', 'localhost prefix Origin'],
    ['localhost', 'http://127.0.0.1.evil.com', 'IPv4 prefix Origin'],
    ['localhost', 'http://127.evil.com', '127 prefix Origin'],
    ['localhost', 'file://localhost/x', 'non-http Origin'], ['localhost', 'ftp://localhost', 'non-http Origin, local name'], ['localhost', 'chrome-extension://localhost', 'extension Origin, local name'],
    ['localhost', '', 'empty Origin'],
  ])('rejects Host %j Origin %j (%s)', (host, origin, _why) => {
    const headers: Record<string, string> = {};
    if (host !== undefined) headers.host = host;
    if (origin !== undefined) headers.origin = origin;
    const r = checkRequestOrigin(headers);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTypeOf('string');
  });

  it('accepts extra hosts from allowedHosts for Host and Origin, case-insensitively', () => {
    expect(checkRequestOrigin({ host: 'Api.Internal:80' }, ['api.internal'])).toEqual({ ok: true });
    expect(checkRequestOrigin({ host: 'localhost', origin: 'https://app.internal' }, ['APP.internal'])).toEqual({ ok: true });
    expect(checkRequestOrigin({ host: 'api.internal' }).ok).toBe(false);
  });
});

describe('bearerMatches', () => {
  it.each([
    ['Bearer k', 'k', true],
    ['Bearer kk', 'k', false],
    ['Bearer ', 'k', false],
    ['bearer k', 'k', false],
    ['Basic k', 'k', false],
    ['Bearer k ', 'k', false],
    [undefined, 'k', false],
  ])('%j vs key %j -> %s', (header, key, expected) => {
    expect(bearerMatches(header, key)).toBe(expected);
  });
  it('rejects an array-valued header', () => {
    expect(bearerMatches(['Bearer k'], 'k')).toBe(false);
  });
});

describe('isJsonContentType', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['APPLICATION/JSON', true],
    [' application/json ;charset=x', true],
    ['text/json', false],
    ['application/jsonx', false],
    ['text/plain', false],
    ['', false],
    [undefined, false],
  ])('%j -> %s', (ct, expected) => {
    expect(isJsonContentType(ct)).toBe(expected);
  });
});
