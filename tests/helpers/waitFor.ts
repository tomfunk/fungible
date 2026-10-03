/**
 * Polling waitFor for async UI tests (ink-testing-library, React effects).
 * Drop-in for the hand-rolled `waitFor(assertion, timeout)` copies in
 * tests/tui/*: same positional signature, plus a clearer timeout error.
 */

export interface WaitForOptions {
  /** Max wait in ms. Default 1500. */
  timeout?: number;
  /** Poll interval in ms. Default 30. */
  interval?: number;
  /** Extra context appended to the timeout error (e.g. the last frame). Called lazily, only on failure. */
  context?: () => string;
}

/**
 * Re-runs `assertion` until it stops throwing or the timeout elapses.
 * On timeout throws an Error carrying the last assertion failure as its
 * message (and `cause`), plus `context()` output when provided.
 */
export async function waitFor(
  assertion: () => void | Promise<void>,
  opts: number | WaitForOptions = {},
): Promise<void> {
  const { timeout = 1500, interval = 30, context } =
    typeof opts === 'number' ? { timeout: opts } : opts;
  const deadline = Date.now() + timeout;
  // Iteration cap alongside the deadline: under a pinned/fake Date the
  // deadline never passes, so a failing assertion would otherwise spin until
  // the vitest timeout instead of failing with the last assertion error.
  const maxIterations = Math.max(1, Math.ceil(timeout / Math.max(1, interval))) + 1;
  let lastErr: unknown;
  let iterations = 0;
  do {
    try { await assertion(); return; } catch (e) { lastErr = e; }
    iterations++;
    await new Promise((res) => setTimeout(res, interval));
  } while (Date.now() < deadline && iterations < maxIterations);
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  let extra = '';
  if (context) {
    try { extra = `\n--- context ---\n${context()}`; } catch { /* ignore */ }
  }
  throw new Error(`waitFor timed out after ${timeout}ms: ${reason}${extra}`, { cause: lastErr });
}

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;

/** Removes ANSI escape sequences from `text`. */
export function stripAnsi(text: string | undefined): string {
  return (text ?? '').replace(ANSI_RE, '');
}

/** Last frame with ANSI stripped but line structure kept (use flatFrame to collapse whitespace). */
export function frame(r: Pick<FrameSource, 'lastFrame'>): string {
  return stripAnsi(r.lastFrame());
}

/** Minimal shape of an ink-testing-library render result. */
export interface FrameSource {
  lastFrame(): string | undefined;
  stdin: { write(data: string): void };
}

/** Last frame with ANSI stripped and whitespace collapsed to single spaces. */
export function flatFrame(r: Pick<FrameSource, 'lastFrame'>): string {
  return frame(r).replace(/\s+/g, ' ');
}

/** Waits until the flattened frame contains `text`; timeout error includes the last frame. */
export function waitForFrame(
  r: Pick<FrameSource, 'lastFrame'>,
  text: string,
  opts: number | WaitForOptions = {},
): Promise<void> {
  const o = typeof opts === 'number' ? { timeout: opts } : opts;
  return waitFor(
    () => {
      if (!flatFrame(r).includes(text)) throw new Error(`frame does not contain ${JSON.stringify(text)}`);
    },
    { ...o, context: o.context ?? (() => flatFrame(r)) },
  );
}

/** Writes `key` to stdin, then waits for `text` to appear in the frame. */
export async function pressAndWait(
  r: FrameSource,
  key: string,
  text: string,
  opts: number | WaitForOptions = {},
): Promise<void> {
  r.stdin.write(key);
  await waitForFrame(r, text, opts);
}
