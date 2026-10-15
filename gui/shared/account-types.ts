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
