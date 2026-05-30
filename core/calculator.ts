/**
 * Time Value of Money (TVM) solver.
 *
 * Standard formula: PV*(1+r)^n + PMT*((1+r)^n - 1)/r + FV = 0
 *
 * Sign convention: cash outflows negative, inflows positive.
 * e.g. loan: PV=+100000 (receive), PMT=-537 (pay each month), FV=0, n=360, r=0.005
 *      investment: PV=-10000 (invest), PMT=-500 (add monthly), FV=?, n=120, r=0.005833
 */

/** Helper: (1+r)^n */
function pow(r: number, n: number) { return Math.pow(1 + r, n); }

/** Helper: annuity factor ((1+r)^n - 1) / r, handles r≈0 */
function annuityFactor(r: number, n: number) {
  if (Math.abs(r) < 1e-10) return n;
  return (pow(r, n) - 1) / r;
}

export function calcFV(pv: number, pmt: number, n: number, r: number): number {
  return -(pv * pow(r, n) + pmt * annuityFactor(r, n));
}

export function calcPV(fv: number, pmt: number, n: number, r: number): number {
  return -(fv + pmt * annuityFactor(r, n)) / pow(r, n);
}

export function calcPMT(pv: number, fv: number, n: number, r: number): number {
  if (Math.abs(r) < 1e-10) return -(pv + fv) / n;
  return -(pv * pow(r, n) + fv) / annuityFactor(r, n);
}

export function calcN(pv: number, fv: number, pmt: number, r: number): number {
  if (Math.abs(r) < 1e-10) {
    if (Math.abs(pmt) < 1e-10) throw new Error('Cannot solve N: both r and pmt are zero.');
    return -(pv + fv) / pmt;
  }
  if (Math.abs(pmt) < 1e-10) {
    if (fv * pv >= 0) throw new Error('Cannot solve N: PV and FV have the same sign with no payment.');
    return Math.log(-fv / pv) / Math.log(1 + r);
  }
  const num = pmt - fv * r;
  const den = pmt + pv * r;
  if (num / den <= 0) throw new Error('Cannot solve N: no solution exists for these inputs.');
  return Math.log(num / den) / Math.log(1 + r);
}

/** Newton-Raphson solver for periodic rate. Returns rate per period. */
export function calcRate(pv: number, fv: number, pmt: number, n: number, guess = 0.01): number {
  const f  = (r: number) => pv * pow(r, n) + pmt * annuityFactor(r, n) + fv;
  const df = (r: number) => {
    const p = pow(r, n);
    return pv * n * p / (1 + r) + pmt * (n * p / (1 + r) / r - annuityFactor(r, n) / r);
  };

  let r = guess;
  for (let i = 0; i < 200; i++) {
    const fr = f(r);
    const dfr = df(r);
    if (Math.abs(dfr) < 1e-15) break;
    const next = r - fr / dfr;
    if (!isFinite(next) || next <= -1) { r = r / 2; continue; }
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  if (Math.abs(f(r)) > 0.01) throw new Error('Rate solver did not converge. Check your inputs.');
  return r;
}

export type TVMInput = {
  pv?:   number;
  fv?:   number;
  pmt?:  number;
  n?:    number;
  rate?: number; // periodic rate (e.g. monthly rate = annual% / 100 / 12)
};

export type TVMResult = TVMInput & { solved: keyof TVMInput; value: number };

/** Solve for the one missing TVM variable. Exactly one field must be undefined/null. */
export function solveTVM(input: TVMInput): TVMResult {
  const missing = (['pv', 'fv', 'pmt', 'n', 'rate'] as const).filter((k) => input[k] == null);
  if (missing.length !== 1) throw new Error(`Provide exactly 4 of 5 TVM variables. Missing: ${missing.join(', ') || 'none'}.`);
  const solve = missing[0];

  const pv   = input.pv   ?? 0;
  const fv   = input.fv   ?? 0;
  const pmt  = input.pmt  ?? 0;
  const n    = input.n    ?? 0;
  const rate = input.rate ?? 0;

  let value: number;
  switch (solve) {
    case 'fv':   value = calcFV(pv, pmt, n, rate); break;
    case 'pv':   value = calcPV(fv, pmt, n, rate); break;
    case 'pmt':  value = calcPMT(pv, fv, n, rate); break;
    case 'n':    value = calcN(pv, fv, pmt, rate); break;
    case 'rate': value = calcRate(pv, fv, pmt, n); break;
  }

  return { ...input, [solve]: value, solved: solve, value };
}
