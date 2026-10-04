import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});
vi.mock('../../core/profile.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/profile.js')>();
  return { ...actual, loadProfile: vi.fn(() => Promise.resolve(null)), saveProfile: vi.fn(() => Promise.resolve()) };
});

import { db } from '../../core/db.js';
import { Health } from '../../tui/Health.js';
import { waitFor, frame, press, pressKeys } from '../helpers/waitFor.js';
import { W, noop, useEmptyScreenDb } from './helpers/screenSetup.js';

// Empty database: spend floors at $100, savings default $0, pretax $0, withdrawal 4.0%, growth 7.0%.
useEmptyScreenDb();

const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const DOWN = '\u001b[B';

function health() {
  return render(<W><Health onNavigate={noop} showHints={false} /></W>);
}

/** The dial value shown in the bracket on the row labelled `label`. */
function dial(r: ReturnType<typeof render>, label: string): string {
  const line = frame(r).split('\n').find((l) => l.includes(label));
  const m = line?.match(/\[\s*([^\]]*?)\s*\]/);
  if (!m) throw new Error(`no dial row for ${label}:\n${frame(r)}`);
  return m[1];
}

async function openAt(index: number) {
  const r = health();
  await waitFor(() => expect(frame(r)).toContain('Monthly spending'));
  await pressKeys(r, Array(index).fill(DOWN));
  return r;
}

const rep = (key: string, n: number) => Array<string>(n).fill(key);

/** [key, repeat count, value expected afterwards]. A step that expects the previous value is a clamp. */
type Step = [key: string, times: number, expected: string];
interface DialCase { name: string; label: string; index: number; start: string; steps: Step[] }
const DIALS: DialCase[] = [
  { name: 'monthly spend (+-$100, floor $100, no ceiling)', label: 'Monthly spending', index: 0, start: '$100.00',
    steps: [[LEFT, 1, '$100.00'], [RIGHT, 1, '$200.00'], [RIGHT, 2, '$400.00'], [LEFT, 5, '$100.00'], [RIGHT, 1, '$200.00']] },
  { name: 'monthly savings (+-$100, unbounded)', label: 'Monthly savings', index: 1, start: '+$0.00',
    steps: [[RIGHT, 1, '+$100.00'], [LEFT, 1, '+$0.00'], [LEFT, 2, '-$200.00'], [RIGHT, 5, '+$300.00']] },
  { name: 'withdrawal rate (+-0.5, clamp 0.5..10)', label: 'Withdrawal rate', index: 3, start: '4.0%',
    steps: [[RIGHT, 1, '4.5%'], [LEFT, 1, '4.0%'], [RIGHT, 15, '10.0%'], [RIGHT, 1, '10.0%'], [LEFT, 25, '0.5%'], [LEFT, 1, '0.5%']] },
  { name: 'growth rate (+-1, clamp 0..20)', label: 'Growth rate', index: 4, start: '7.0%',
    steps: [[RIGHT, 1, '8.0%'], [RIGHT, 20, '20.0%'], [RIGHT, 1, '20.0%'], [LEFT, 25, '0.0%'], [LEFT, 1, '0.0%']] },
];

describe('Health assumption dials', () => {
  it.each(DIALS)('$name: step, clamp, then [r] resets to the default', async (d) => {
    const r = await openAt(d.index);
    expect(frame(r)).toMatch(new RegExp(`▶ ${d.label}`));
    expect(dial(r, d.label)).toBe(d.start);

    for (const [key, times, expected] of d.steps) {
      await pressKeys(r, rep(key, times));
      await new Promise((res) => setTimeout(res, 40)); // let a would-be overshoot render before asserting a clamp
      await waitFor(() => expect(dial(r, d.label)).toBe(expected));
    }

    await press(r, 'r');
    await waitFor(() => expect(dial(r, d.label)).toBe(d.start));
  });

  it('dials are independent: moving one leaves the others at their defaults', async () => {
    const r = await openAt(4);
    await press(r, RIGHT);
    await waitFor(() => expect(dial(r, 'Growth rate')).toBe('8.0%'));
    expect(dial(r, 'Monthly spending')).toBe('$100.00');
    expect(dial(r, 'Monthly savings')).toBe('+$0.00');
    expect(dial(r, 'Pretax savings')).toBe('$0.00');
    expect(dial(r, 'Withdrawal rate')).toBe('4.0%');
  });
});

describe('Health pretax dial persistence', () => {
  const stored = async () => (await db.execute("SELECT value FROM settings WHERE key = 'pretax_monthly'")).rows[0]?.value;

  it('→ persists the new amount, ← at 0 stays 0, [r] writes 0', async () => {
    const r = await openAt(2);
    expect(dial(r, 'Pretax savings')).toBe('$0.00');

    await press(r, LEFT); // floor at 0; whatever is written must still be 0
    await new Promise((res) => setTimeout(res, 50));
    expect(dial(r, 'Pretax savings')).toBe('$0.00');
    const afterFloor = await stored();
    expect(afterFloor === undefined || Number(afterFloor) === 0).toBe(true);

    await press(r, RIGHT);
    await waitFor(() => expect(dial(r, 'Pretax savings')).toBe('$100.00'));
    await waitFor(async () => expect(await stored()).toBe('100'));

    await press(r, 'r');
    await waitFor(() => expect(dial(r, 'Pretax savings')).toBe('$0.00'));
    await waitFor(async () => expect(await stored()).toBe('0'));
  });

  it('a stored amount is loaded on the next mount', async () => {
    await db.execute("INSERT INTO settings (key, value) VALUES ('pretax_monthly', '300')");
    const r = health();
    await waitFor(() => expect(dial(r, 'Pretax savings')).toBe('$300.00'));
  });
});
