// Hybrid logical clock. Portable (no node:* imports).
//
// Wire/storage format: `%015d-%05d-<device_id>` -- zero-padded wall-clock ms,
// a counter, and the originating device id -- so plain string comparison IS
// HLC order and device_id breaks ties deterministically.
//
// The SQLite triggers in sync-oplog.ts generate the same format in SQL; this
// module is the JS side (backfill, adoption, re-stamping, clock observation).

export interface HlcState { wall: number; counter: number }

/** Server rejects wall > its now + 5min (`invalid_hlc`); stay under that. */
export const MAX_FUTURE_MS = 5 * 60_000;
export const MAX_COUNTER = 99_999;

export function formatHlc(wall: number, counter: number, device: string): string {
  return `${String(Math.trunc(wall)).padStart(15, '0')}-${String(counter).padStart(5, '0')}-${device}`;
}

export function parseHlc(hlc: string): { wall: number; counter: number; device: string } | null {
  const m = /^(\d{15})-(\d{5})-(.+)$/.exec(hlc);
  if (!m) return null;
  return { wall: Number(m[1]), counter: Number(m[2]), device: m[3] };
}

/** Next HLC state after a local event at `nowMs`. Never moves backwards. */
export function tickHlc(last: HlcState, nowMs: number): HlcState {
  const wall = Math.max(last.wall, nowMs);
  if (wall === last.wall) {
    // Counter overflow: borrow a millisecond rather than exceed the width.
    if (last.counter >= MAX_COUNTER) return { wall: wall + 1, counter: 0 };
    return { wall, counter: last.counter + 1 };
  }
  return { wall, counter: 0 };
}

/**
 * Fold a remote HLC into the local clock so later local events order after it.
 * A remote wall far in the future (skewed peer) is clamped, never adopted.
 */
export function observeHlc(last: HlcState, remote: string, nowMs: number): HlcState {
  const p = parseHlc(remote);
  if (!p) return last;
  const wall = Math.min(p.wall, nowMs + MAX_FUTURE_MS);
  if (wall > last.wall) return { wall, counter: p.counter };
  if (wall === last.wall && p.counter > last.counter) return { wall, counter: p.counter };
  return last;
}

/** True when an HLC's wall clock is beyond what the server would accept. */
export function isFarFuture(hlc: string, nowMs: number): boolean {
  const p = parseHlc(hlc);
  return p != null && p.wall > nowMs + MAX_FUTURE_MS;
}
