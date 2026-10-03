import type { Client } from '@libsql/client';

/**
 * Plants recognisable secret values where the app keeps them, so a sweep test
 * can assert that no tool or API output ever contains one:
 *   - plaid_items.access_token (plaintext and encrypted-looking, per the legacy/new formats)
 *   - settings rows whose keys look like credentials
 *   - process.env API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, FUNGIBLE_API_KEY, PLAID_SECRET)
 *
 * Returns the planted strings and a `restore()` that puts the environment back;
 * call it in afterEach. Each secret contains the marker 'SECRET-DO-NOT-LEAK',
 * so `leaks(text)` is a simple substring check and failures are self-explaining.
 *
 *   const s = await seedSecrets(db);
 *   afterEach(() => s.restore());
 *   expect(s.leaks(output)).toEqual([]);
 */
export const SECRET_MARKER = 'SECRET-DO-NOT-LEAK';

export interface SeededSecrets {
  secrets: string[];
  /** The planted secrets that appear in `text` (empty means no leak). */
  leaks(text: string): string[];
  restore(): void;
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FUNGIBLE_API_KEY', 'PLAID_SECRET'] as const;

export async function seedSecrets(db: Client): Promise<SeededSecrets> {
  const secrets: string[] = [];
  const plant = (label: string) => {
    const v = `${label}-${SECRET_MARKER}`;
    secrets.push(v);
    return v;
  };

  const plain = plant('access-sandbox-plain');
  const enc = `${plant('iv')}:${plant('tag')}:${plant('ciphertext')}`; // iv:authTag:ciphertext shape
  await db.execute({ sql: 'INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)', args: ['secret-item-1', plain, 'Secret Bank'] });
  await db.execute({ sql: 'INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)', args: ['secret-item-2', enc, 'Secret Bank 2'] });

  for (const key of ['plaid_secret', 'anthropic_api_key', 'openai_api_key', 'api_key']) {
    await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: [key, plant(key)] });
  }

  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    process.env[k] = plant(k);
  }

  return {
    secrets,
    leaks: (text) => secrets.filter((s) => text.includes(s)),
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    },
  };
}
