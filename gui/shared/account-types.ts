// Account / sync contract shared by the desktop main process (gui/main/account-sync.ts),
// the web app (web/src/account-client.ts) and the Settings Account panel.
// Pure types and one pure formatter: safe to import from any process.

/** One sync cycle, reduced to what a person is told about it. */
export type CycleSummary = {
  pushed: number;
  pulled: number;
  /** Local edits that lost to a newer change elsewhere (merged, nothing lost silently). */
  superseded: number;
  /** Changes the server could not place yet; they are retried on the next cycle. */
  retrying: number;
  /** Changes held back because the thing they belong to only exists on this device. */
  held: number;
  /** Changes the server permanently refused; they stay on this device. */
  rejected: number;
  /** This device's clock is far enough off that the server refused its timestamps. */
  clockSkew: boolean;
};

export type AccountState = {
  platform: 'web' | 'desktop';
  mode: 'byok' | 'hosted';
  /** A session exists (or is believed to: a web browser that is offline at boot). */
  signedIn: boolean;
  email: string | null;
  lastSyncAt: string | null;
  pendingCount: number;
  heldCount: number;
  rejectedCount: number;
  /** Web only: false when this browser could not give the app durable storage. */
  persistent: boolean | null;
};

export type ConnectOptions = { createAccount?: boolean; resetForNewAccount?: boolean };

export type ConnectResult =
  | { status: 'connected'; summary: CycleSummary }
  | { status: 'account_mismatch' }
  /** The safety backup taken before enabling sync failed, so sync was not enabled. */
  | { status: 'snapshot_failed'; message: string };

/** Result of a destructive sign-out; `erased:false` always carries the reason data was kept. */
export type EraseResult = { erased: true } | { erased: false; reason: string };

export const SYNC_DISCLOSURE = 'Syncing sends your data to your account on the server.';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Plain-language notes for the parts of a cycle that deserve one. Empty when all is quiet. */
export function cycleNotes(c: Partial<CycleSummary> | undefined | null): string[] {
  if (!c) return [];
  const notes: string[] = [];
  if ((c.superseded ?? 0) > 0) notes.push(`${plural(c.superseded!, 'edit', 'edits')} merged with newer changes`);
  const waiting = (c.retrying ?? 0) + (c.held ?? 0);
  if (waiting > 0) notes.push(`${plural(waiting, 'change', 'changes')} waiting on other data, will retry`);
  if ((c.rejected ?? 0) > 0) notes.push(`${plural(c.rejected!, 'change', 'changes')} rejected by the server`);
  if (c.clockSkew) notes.push("this device's clock looks wrong, so some changes were not accepted; check the date and time");
  return notes;
}

export function describeCycle(c: CycleSummary): string {
  const head = `Synced: ${c.pulled} pulled, ${c.pushed} pushed`;
  const notes = cycleNotes(c);
  return notes.length ? `${head} · ${notes.join(' · ')}` : head;
}

/** Message shown when the sync server cannot be reached at all. */
export const UNREACHABLE_MESSAGE = "Can't reach the sync server. Check your connection and try again.";

const IPC_PREFIX = /^(?:Error:\s*)?Error invoking remote method '[^']*':\s*/;
const NETWORK_FAILURE = /fetch failed|failed to fetch|networkerror|network request failed|load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|sync server unreachable/i;

/**
 * One cleaner for every error string a person sees from the account/sync path.
 * Strips Electron's IPC wrapper ("Error invoking remote method 'bridge:call': ")
 * and a leading "TypeError: " / "Error: ", and maps network-level failures to a
 * friendly sentence. `detail` always keeps the unwrapped raw text for a tooltip
 * or console, so diagnostics are not lost.
 */
export function describeError(err: unknown): { message: string; detail: string; network: boolean } {
  let raw = err instanceof Error ? err.message : String(err);
  raw = raw.replace(IPC_PREFIX, '').replace(/^(?:[A-Za-z]*Error):\s*/, '').trim();
  if (raw === '') raw = 'Unknown error';
  if (NETWORK_FAILURE.test(raw)) return { message: UNREACHABLE_MESSAGE, detail: raw, network: true };
  return { message: raw, detail: raw, network: false };
}
