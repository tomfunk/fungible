import { describe, it, expect } from 'vitest';
import { calcFV, calcPV, calcPMT, calcN, calcRate, solveTVM } from '../core/calculator.js';
import { executeTool } from '../core/tools.js';

describe('textbook values', () => {
  it('FV of $10,000 invested at 6%/yr for 10 years is $17,908.48', () => {
    expect(calcFV(-10000, 0, 10, 0.06)).toBeCloseTo(17908.48, 2);
  });

  it('monthly payment on a $100,000 30-year loan at 0.5%/month is -599.55', () => {
    expect(calcPMT(100000, 0, 360, 0.005)).toBeCloseTo(-599.55, 2);
  });

  it('PV of a $1,000/yr 10-year annuity at 5% is $7,721.73', () => {
    expect(calcPV(0, -1000, 10, 0.05)).toBeCloseTo(7721.73, 2);
  });

  it('periods to double at 7% is about 10.24', () => {
    expect(calcN(-1, 2, 0, 0.07)).toBeCloseTo(10.2448, 3);
  });

  it('calcRate recovers the 0.5%/month rate of the known loan', () => {
    expect(calcRate(100000, 0, -599.55, 360)).toBeCloseTo(0.005, 5);
  });
});

describe('zero rate', () => {
  it('FV is just the sum of deposits', () => expect(calcFV(-1000, -100, 10, 0)).toBeCloseTo(2000));
  it('PV is just the negated sum', () => expect(calcPV(2000, -100, 10, 0)).toBeCloseTo(-1000));
  it('PMT spreads principal evenly', () => expect(calcPMT(1200, 0, 12, 0)).toBeCloseTo(-100));
  it('N divides the balance by the payment', () => expect(calcN(1200, 0, -100, 0)).toBeCloseTo(12));
  it('calcRate solves a zero-rate problem to ~0 (not exactly 0)', () => {
    expect(calcRate(-1000, 1200, 0, 10)).toBeGreaterThan(0);
    expect(calcRate(1200, 0, -100, 12)).toBeCloseTo(0, 6);
  });
});

describe('round trips through solveTVM', () => {
  const base = { pv: -5000, pmt: -200, n: 60, rate: 0.004 };
  const fv = calcFV(base.pv, base.pmt, base.n, base.rate);
  const full = { ...base, fv };

  it.each(['pv', 'fv', 'pmt', 'n', 'rate'] as const)('solving for %s gives back the original', (key) => {
    const { [key]: expected, ...rest } = full;
    const r = solveTVM(rest);
    expect(r.solved).toBe(key);
    expect(r.value).toBeCloseTo(expected, key === 'rate' ? 8 : 4);
    expect(r[key]).toBe(r.value);
  });
});

describe('errors', () => {
  it('calcN with r=0 and pmt=0 cannot be solved', () => {
    expect(() => calcN(100, -100, 0, 0)).toThrow('both r and pmt are zero');
  });

  it('calcN with same-sign PV and FV and no payment cannot be solved', () => {
    expect(() => calcN(100, 200, 0, 0.05)).toThrow('same sign');
  });

  it('calcN throws when the payment cannot cover the interest', () => {
    expect(() => calcN(1000, 0, -1, 0.05)).toThrow('no solution');
  });

  it.each([
    ['none missing', { pv: 1, fv: 1, pmt: 1, n: 1, rate: 0.1 }],
    ['three missing', { pv: 1, fv: 1 }],
    ['five missing', {}],
  ])('solveTVM requires exactly one missing variable (%s)', (_n, input) => {
    expect(() => solveTVM(input)).toThrow('exactly 4 of 5');
  });

  it('calcRate throws when Newton does not converge', () => {
    expect(() => calcRate(1000, 1000, 0, 10)).toThrow('did not converge');
  });

  it('calcPMT with zero periods is a clear error, not -Infinity', () => {
    expect(() => calcPMT(1000, 0, 0, 0.005)).toThrow(/periods/i);
    expect(() => calcPMT(1000, 0, 0, 0)).toThrow(/periods/i);
  });
});

describe('degenerate inputs', () => {
  // Total loss: -1000 never recovers, so the solver settles near -100% per period
  // (~-0.993 over 10 periods). Pinned as current behaviour, not endorsed.
  it('calcRate(-1000, 0, 0, 10) lands near -0.993', () => {
    expect(calcRate(-1000, 0, 0, 10)).toBeCloseTo(-0.993, 2);
  });
});

describe('calculate_tvm tool', () => {
  it('surfaces a zero-period solve as an Error: message, not a crash', async () => {
    const out = await executeTool('calculate_tvm', { pv: 1000, fv: 0, n: 0, rate: 0.005 });
    expect(out).toMatch(/^Error: .*periods/i);
  });

  it('reports the solved value', async () => {
    const out = await executeTool('calculate_tvm', { pv: 100000, fv: 0, n: 360, rate: 0.005 });
    expect(out).toContain('solved for: PMT = -599.55');
  });
});
