// Deterministic ids for synced rows. Portable (web-standard crypto only).
//
// Tags and rules have local AUTOINCREMENT ids, but the server identifies them
// by uuid and enforces uniqueness on their natural key (per user). Two devices
// that create the same tag / rule independently must therefore converge on ONE
// server row, so the uuid is derived (uuidv5-style SHA-1) from
// (namespace, userId, natural key) instead of being random. Different users
// never collide because the user id is part of the input.

async function sha1Uuid(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const h = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MEMBER_NS = 'fungible/household_member/v1';

/** household_members.id is a Postgres UUID on the server but 'self'/'spouse'/'child-N' locally. */
export function deriveMemberUuid(userId: string, localId: string): Promise<string> {
  return sha1Uuid(`${MEMBER_NS}:${userId}:${localId}`);
}

export function deriveTagUuid(userId: string, name: string): Promise<string> {
  return sha1Uuid(`fungible/tag/v1:${userId}:${name}`);
}

export function deriveRuleUuid(
  userId: string,
  table: 'category_rules' | 'name_rules',
  matchType: string,
  pattern: string,
): Promise<string> {
  return sha1Uuid(`fungible/${table}/v1:${userId}:${matchType}:${pattern}`);
}

/** `csv-<uuidv5>` over (user, the account's wire id, the row's dedup key). */
export async function deriveCsvTxId(userId: string, accountWireId: string, dedupKey: string): Promise<string> {
  return `csv-${await sha1Uuid(`fungible/csv_tx/v1:${userId}:${accountWireId}:${dedupKey}`)}`;
}

/** Wire id of an import: uuidv5 over (user, file hash, the account's wire id). */
export function deriveImportWireId(userId: string, fileHash: string, accountWireId: string): Promise<string> {
  return sha1Uuid(`fungible/import/v1:${userId}:${fileHash}:${accountWireId}`);
}

const normPart = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Wire id of a client-owned account: `acct-<uuidv5>` over the user and the
 * account's natural key at FIRST derivation. The id never changes afterwards
 * (a rename keeps it; the caller persists it in accounts.wire_id). `dup`
 * disambiguates two accounts that share a natural key on one device.
 */
export async function deriveAccountWireId(
  userId: string,
  a: { institution_name?: unknown; name: unknown; type?: unknown; subtype?: unknown },
  dup = 0,
): Promise<string> {
  const kind = `${normPart(a.type)}/${normPart(a.subtype)}`;
  const uuid = await sha1Uuid(
    `fungible/account/v1:${userId}:${normPart(a.institution_name)}:${normPart(a.name)}:${kind}:${dup}`,
  );
  return `acct-${uuid}`;
}
