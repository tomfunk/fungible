import { vi } from 'vitest';

/** Minimal slice of a libsql Client these helpers touch. */
type DbLike = { execute: any; batch: any; transaction: any };

/**
 * Makes every execute/batch/transaction on `db` reject with `new Error(message)`.
 * Returns restore() which puts the original methods back.
 */
export function failDb(db: DbLike, message = 'db failure'): () => void {
  const spies = (['execute', 'batch', 'transaction'] as const).map((m) =>
    vi.spyOn(db, m).mockImplementation(() => Promise.reject(new Error(message))),
  );
  return () => spies.forEach((s) => s.mockRestore());
}

/**
 * Holds every execute/batch call on `db` behind one shared promise, so a test can
 * observe the in-flight (loading) state. release() lets all held calls (and any later
 * ones) run against the real db; restore() removes the gate (release first if calls are pending).
 */
export function gateDb(db: DbLike): { release: () => void; restore: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const spies = (['execute', 'batch'] as const).map((m) => {
    const orig = db[m].bind(db);
    return vi.spyOn(db, m).mockImplementation((...args: unknown[]) => gate.then(() => orig(...args)));
  });
  return { release, restore: () => spies.forEach((s) => s.mockRestore()) };
}

/**
 * Collects unhandled promise rejections while installed. Having a listener means node
 * does not raise them as errors (and vitest does not fail the run on them).
 * Call stop() to remove the listener.
 */
export function captureUnhandled(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', onRejection);
  return { seen, stop: () => { process.off('unhandledRejection', onRejection); } };
}
