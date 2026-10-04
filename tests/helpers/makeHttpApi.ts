import http from 'node:http';

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** Parsed body, or undefined when it is not JSON (SSE, empty). */
  json: any;
}

export interface RawRequestOptions {
  body?: string | Buffer;
  /** Address to connect to (default 127.0.0.1); use for servers bound to a concrete non-loopback address. */
  connectHost?: string;
  /** A null value omits the header. A Host key suppresses Node's automatic Host. */
  headers?: Record<string, string | null>;
}

/**
 * Low-level request to a loopback test server. Unlike fetch it lets a test
 * send forbidden headers (Host, Origin), omit Content-Type, and use any method.
 */
export function rawRequest(
  port: number,
  method: string,
  path: string,
  opts: RawRequestOptions = {},
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== null) headers[k] = v;
    const hasHost = Object.keys(headers).some((k) => k.toLowerCase() === 'host');
    const req = http.request({ host: opts.connectHost ?? '127.0.0.1', port, method, path, headers, setHost: !hasHost }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * Stream a body in `chunks` pieces of `chunkBytes` with no Content-Length
 * (chunked encoding), so the server's streaming byte counter is exercised
 * rather than its declared-length shortcut. Resolves with the status the
 * server answered, or 'reset' if the connection was torn down first.
 */
export function streamBody(
  port: number,
  path: string,
  chunks: number,
  chunkBytes: number,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
): Promise<number | 'reset'> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | 'reset') => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { ...headers, 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      done(res.statusCode!);
    });
    // The server may tear the socket down right after answering 413; give a buffered response a tick to surface first.
    req.on('error', () => setTimeout(() => done('reset'), 50));
    const piece = Buffer.alloc(chunkBytes, 0x78);
    let i = 0;
    const next = () => {
      if (settled || req.destroyed) return;
      if (i++ >= chunks) return void req.end();
      req.write(piece, () => setImmediate(next));
    };
    next();
  });
}
