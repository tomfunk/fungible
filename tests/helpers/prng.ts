// Seeded, deterministic PRNG for property-style tests (no fast-check dependency).
// Always put the seed in the assertion message so a failure is reproducible:
//
//   const SEED = 20261003;
//   const r = mulberry32(SEED);
//   expect(got, `seed=${SEED} case=${i}`).toBe(want);

/** mulberry32: returns a function yielding floats in [0, 1). Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi], inclusive. */
export const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

/** One element of a non-empty array. */
export const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)];
