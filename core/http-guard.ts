import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

/** Default request-body cap for the local HTTP servers (1 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Lowercase, strip brackets around IPv6 literals and a single trailing dot. */
function normalizeHostname(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/**
 * True for names/addresses that can only be reached from this machine:
 * "localhost" (a trailing dot is accepted), any 127.0.0.0/8 address and ::1.
 * Wildcard binds (0.0.0.0, ::), LAN addresses and every other name are non-local.
 */
export function isLocalHost(host: string): boolean {
  const h = normalizeHostname(host);
  if (h === 'localhost' || h === '::1') return true;
  if (isIP(h) === 4) return h.split('.')[0] === '127';
  return false;
}

/** Parse the hostname out of a Host header value (with optional port). Null when malformed. */
function hostnameFromHostHeader(value: string): string | null {
  // Reject anything that is not a bare host[:port]: userinfo, paths, whitespace.
  if (!value || /[\s@/?#\\]/.test(value)) return null;
  try {
    return normalizeHostname(new URL(`http://${value}`).hostname);
  } catch {
    return null;
  }
}

export type OriginCheck = { ok: true } | { ok: false; reason: string };

/**
 * DNS-rebinding / cross-site guard. The Host header must name this machine
 * (or an entry of allowedHosts); an Origin header, when present, must be an
 * http(s) URL whose hostname does too. A missing Origin is fine (non-browser
 * clients), a missing Host is not. Hostnames are parsed, never prefix-matched.
 */
export function checkRequestOrigin(headers: IncomingHttpHeaders, allowedHosts: string[] = []): OriginCheck {
  const allowed = new Set(allowedHosts.map(normalizeHostname));
  const okName = (name: string) => isLocalHost(name) || allowed.has(name);

  const host = headers.host;
  if (typeof host !== 'string' || host === '') return { ok: false, reason: 'missing Host header' };
  const hostname = hostnameFromHostHeader(host);
  if (hostname === null) return { ok: false, reason: 'malformed Host header' };
  if (!okName(hostname)) return { ok: false, reason: 'Host not allowed' };

  const origin = headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string') return { ok: false, reason: 'malformed Origin header' };
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return { ok: false, reason: 'malformed Origin header' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'Origin not allowed' };
    if (!okName(normalizeHostname(url.hostname))) return { ok: false, reason: 'Origin not allowed' };
  }
  return { ok: true };
}

/** Constant-time check of `Authorization: Bearer <key>` (exact scheme, exact key). */
export function bearerMatches(authHeader: string | string[] | undefined, key: string): boolean {
  if (typeof authHeader !== 'string') return false;
  const a = createHash('sha256').update(authHeader).digest();
  const b = createHash('sha256').update(`Bearer ${key}`).digest();
  return timingSafeEqual(a, b);
}

/** True when the Content-Type media type is application/json (parameters such as charset allowed). */
export function isJsonContentType(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function sendJson(res: ServerResponse, status: number, body: object, extraHeaders: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(json);
}

export type BodyResult = { ok: true; raw: string } | { ok: false; tooLarge: true };

/** Read a request body, counting bytes (not characters) while streaming. */
export function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return resolve({ ok: false, tooLarge: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        chunks.length = 0;
        resolve({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

/** Respond 413, then drop the connection so the rest of the body is not read. */
export function sendTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.once('finish', () => req.destroy());
  sendJson(res, 413, { error: 'request body too large' }, { Connection: 'close' });
}
