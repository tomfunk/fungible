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
  let lastErr: unknown;
  do {
    try { await assertion(); return; } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, interval));
  } while (Date.now() < deadline);
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  let extra = '';
  if (context) {
    try { extra = `\n--- context ---\n${context()}`; } catch { /* ignore */ }
  }
  throw new Error(`waitFor timed out after ${timeout}ms: ${reason}${extra}`, { cause: lastErr });
}

const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJ]/g;

/** Minimal shape of an ink-testing-library render result. */
export interface FrameSource {
  lastFrame(): string | undefined;
  stdin: { write(data: string): void };
}

/** Last frame with ANSI stripped and whitespace collapsed to single spaces. */
export function flatFrame(r: Pick<FrameSource, 'lastFrame'>): string {
  return (r.lastFrame() ?? '').replace(ANSI_RE, '').replace(/\s+/g, ' ');
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
