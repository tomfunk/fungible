import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import type { AuthAdapter } from './auth-client.js';

// Node-only token adapter: keeps the sync-account access/refresh tokens in
// DATA_DIR/.env (mode 0600). Split from auth-client.ts so the sync engine and
// auth client stay bundleable for the browser.

const ENV_PATH = path.join(DATA_DIR, '.env');
const ACCESS_KEY = 'FUNGIBLE_SYNC_ACCESS_TOKEN';
const REFRESH_KEY = 'FUNGIBLE_SYNC_REFRESH_TOKEN';

function readEnvKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* file missing — ok */ }
  return out;
}

// updates: { KEY: 'value' } sets/replaces, { KEY: null } deletes
function writeEnvKeys(updates: Record<string, string | null>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of existing) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m && m[1] in updates) {
      const val = updates[m[1]];
      if (val !== null) {
        out.push(`${m[1]}=${val}`);
        seen.add(m[1]);
      }
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(updates)) {
    if (v !== null && !seen.has(k)) out.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
}

export function envFileAuthAdapter(): AuthAdapter {
  return {
    getAccessToken: () => readEnvKeys()[ACCESS_KEY] ?? null,
    getRefreshToken: () => readEnvKeys()[REFRESH_KEY] ?? null,
    setTokens: (access, refresh) => {
      const updates: Record<string, string | null> = { [ACCESS_KEY]: access };
      if (refresh !== null) updates[REFRESH_KEY] = refresh;
      writeEnvKeys(updates);
    },
    clear: () => writeEnvKeys({ [ACCESS_KEY]: null, [REFRESH_KEY]: null }),
  };
}

