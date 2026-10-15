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
