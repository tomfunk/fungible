import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { waitFor, waitForFrame, pressAndWait, stripAnsi, frame } from './waitFor.js';
import { makeFakePlaid, makeFakeLlm } from './makeFakeProvider.js';
import { useFixedClock } from './fakeClock.js';
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

describe('waitFor under a pinned clock', () => {
  useFixedClock();
  it('fails with the assertion error instead of spinning forever', async () => {
    await expect(
      waitFor(() => { throw new Error('still wrong'); }, { timeout: 100, interval: 10 }),
    ).rejects.toThrow(/timed out after 100ms: still wrong/);
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

describe('stripAnsi / frame', () => {
  it('strips colour codes and keeps line structure', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m\nx')).toBe('red\nx');
    expect(frame({ lastFrame: () => '\x1b[32mok\x1b[39m\n b' })).toBe('ok\n b');
    expect(frame({ lastFrame: () => undefined })).toBe('');
  });
});

describe('makeFakePlaid / makeFakeLlm', () => {
  it('pages derive has_more and cursors; Error pages reject', async () => {
    const p = makeFakePlaid({ pages: [{ added: [{ id: 1 }] }, new Error('boom')] });
    const first = await p.transactionsSync();
    expect(first.data).toMatchObject({ has_more: true, next_cursor: 'cursor-1' });
    await expect(p.transactionsSync()).rejects.toThrow('boom');
  });
  it('llm replays scripted replies and records requests', async () => {
    const l = makeFakeLlm(['a', (r) => `echo:${String(r)}`]);
    expect(await l.complete('x')).toBe('a');
    expect(await l.complete('y')).toBe('echo:y');
    expect(l.calls()).toEqual(['x', 'y']);
  });
});
