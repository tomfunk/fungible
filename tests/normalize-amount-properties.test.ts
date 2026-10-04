import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { normalizeAmount, MAX_MANUAL_AMOUNT } from '../core/transactions.js';
import { mulberry32, int, pick } from './helpers/prng.js';

const SEED = 20261003;
const sample = (r: () => number) => {
  const mag = pick(r, [1, 100, 1e5, 1e8, 999_999_999]);
  // Mix of 2dp values, 3-4dp half-cent neighbours and raw doubles.
  const kind = int(r, 0, 2);
  const base = kind === 0 ? int(r, -mag * 100, mag * 100) / 100
    : kind === 1 ? int(r, -mag * 1000, mag * 1000) / 1000
    : (r() * 2 - 1) * mag;
  return base;
};

describe('normalizeAmount properties', () => {
  it('idempotent, symmetric, on the cent grid, within half a cent of the input, never -0', () => {
    const r = mulberry32(SEED);
    for (let i = 0; i < 1000; i++) {
      const x = sample(r);
      const msg = `seed=${SEED} case=${i} x=${x}`;
      let y: number;
      try { y = normalizeAmount(x); } catch { expect(Math.abs(x), msg).toBeGreaterThan(MAX_MANUAL_AMOUNT - 0.01); continue; }
      expect(Object.is(y, -0), msg).toBe(false);
      expect(normalizeAmount(y), msg).toBe(y);                       // idempotent
      expect(Math.abs(Math.round(y * 100) - y * 100), msg).toBeLessThan(1e-3); // cent grid (y*100 reaches 1e11; ulp noise ~1e-5)
      expect(Math.abs(y - x), msg).toBeLessThanOrEqual(0.005 + 1e-6);
      expect(Math.abs(y), msg).toBeLessThan(MAX_MANUAL_AMOUNT);
      expect(normalizeAmount(-x), msg).toBe(-y + 0); // half away from zero is odd-symmetric
    }
  });

  it('rejects every non-finite or out-of-range input, whatever the sign', () => {
    const r = mulberry32(SEED + 1);
    for (const x of [NaN, Infinity, -Infinity]) expect(() => normalizeAmount(x)).toThrow();
    for (let i = 0; i < 200; i++) {
      const x = (r() < 0.5 ? -1 : 1) * (MAX_MANUAL_AMOUNT + r() * 1e12);
      expect(() => normalizeAmount(x), `seed=${SEED + 1} x=${x}`).toThrow();
    }
  });
});
