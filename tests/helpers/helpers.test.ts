import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { waitFor, waitForFrame, pressAndWait } from './waitFor.js';
import { useTempCsv } from './tempCsv.js';

describe('waitFor', () => {
  it('resolves once the assertion passes', async () => {
    let n = 0;
    await waitFor(() => { if (++n < 3) throw new Error('no'); }, 500);
    expect(n).toBe(3);
  });
  it('times out with last error and context', async () => {
    await expect(
      waitFor(() => { throw new Error('nope'); }, { timeout: 60, context: () => 'FRAME' }),
    ).rejects.toThrow(/timed out after 60ms: nope[\s\S]*FRAME/);
  });
  it('waitForFrame / pressAndWait use the flattened frame', async () => {
    let frame = 'a\n  b';
    const r = { lastFrame: () => frame, stdin: { write: () => { frame = 'done  now'; } } };
    await waitForFrame(r, 'a b');
    await pressAndWait(r, 'x', 'done now');
    await expect(waitForFrame(r, 'zzz', 50)).rejects.toThrow(/zzz[\s\S]*done now/);
  });
});

describe('useTempCsv', () => {
  const t = useTempCsv('helper-selftest-');
  it('writes unique files', () => {
    const a = t.csv('x,y\n1,2\n');
    const b = t.csv('z');
    expect(a).not.toBe(b);
    expect(readFileSync(a, 'utf8')).toBe('x,y\n1,2\n');
    expect(t.csv('q', 'named.csv').endsWith('named.csv')).toBe(true);
  });
  it('dispose removes the dir and is idempotent', () => {
    const t2 = useTempCsv('helper-selftest2-', { autoCleanup: false });
    t2.csv('a');
    t2.dispose(); t2.dispose();
    expect(existsSync(t2.dir)).toBe(false);
  });
});
