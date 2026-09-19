import { db } from './db.js';
import { decryptToken, keyFileExists } from './crypto.js';

export interface KeyHealth {
  ok: boolean;
  reason?: 'missing_key' | 'decrypt_failed';
  linkedAccountCount?: number;
}

/**
 * Diagnoses whether the encryption key on disk (core/crypto.ts's KEY_FILE_PATH)
 * still matches what encrypted the stored Plaid access tokens. A key lost or
 * swapped (a restored backup that didn't include it, a fresh ~/.fungible/ on a
 * new machine) silently breaks every Plaid connection — sync fails, but with
 * no obvious signal pointing at the key. See issue #179.
 *
 * Returns `{ ok: true }` when there is nothing to protect (no linked
 * accounts) or the key decrypts a stored token successfully. Otherwise
 * `reason` distinguishes a missing key file from one that no longer decrypts
 * (wrong key), and `linkedAccountCount` tells callers how much is at risk.
 */
export async function checkKeyHealth(): Promise<KeyHealth> {
  const countRes = await db.execute(
    'SELECT COUNT(*) as count FROM accounts WHERE item_id IS NOT NULL',
  );
  const linkedAccountCount = Number(
    (countRes.rows[0] as unknown as { count: number | string }).count,
  );

  if (linkedAccountCount === 0) return { ok: true };

  if (!keyFileExists()) {
    return { ok: false, reason: 'missing_key', linkedAccountCount };
  }

  const tokenRes = await db.execute('SELECT access_token FROM plaid_items LIMIT 1');
  const row = tokenRes.rows[0] as unknown as { access_token: string } | undefined;
  if (row) {
    try {
      decryptToken(row.access_token);
    } catch {
      return { ok: false, reason: 'decrypt_failed', linkedAccountCount };
    }
  }

  return { ok: true };
}
