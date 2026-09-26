import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const ENV_PATH = path.join(DATA_DIR, '.env');

const KEY_RE = /^([A-Z][A-Z0-9_]*)=/;

export type EnvUpdates = Record<string, string>;

/** Read ~/.fungible/.env into a key-value map. Missing file returns {}.
 *  Only lines matching KEY=value are parsed (comments and malformed lines are
 *  skipped); values are trimmed. The result is shaped to feed straight back
 *  into writeEnvFile after mutating a value. */
export function readEnvFile(): EnvUpdates {
  const out: EnvUpdates = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(KEY_RE);
    if (m) out[m[1]] = line.slice(m[0].length).trim();
  }
  return out;
}

/** Merge updates into ~/.fungible/.env without exposing existing values.
 *  Empty/whitespace values are ignored. Existing keys are replaced in place;
 *  new keys are appended. Other lines (comments, unrelated keys) are preserved. */
export function writeEnvFile(updates: EnvUpdates): { written: string[]; path: string } {
  const filtered: EnvUpdates = {};
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid env key: ${JSON.stringify(k)}`);
    const value = v.trim();
    if (/[\r\n]/.test(value)) throw new Error(`Value for ${k} must not contain line breaks`);
    filtered[k] = value;
  }
  const written = Object.keys(filtered);
  if (written.length === 0) return { written, path: ENV_PATH };

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = existing ? existing.split('\n') : [];
  const seen = new Set<string>();

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(KEY_RE);
    if (m && filtered[m[1]] !== undefined) {
      out.push(`${m[1]}=${filtered[m[1]]}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const k of written) {
    if (!seen.has(k)) out.push(`${k}=${filtered[k]}`);
  }

  fs.writeFileSync(ENV_PATH, out.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  // writeFileSync only applies mode on creation; tighten pre-existing files too
  fs.chmodSync(ENV_PATH, 0o600);
  return { written, path: ENV_PATH };
}
