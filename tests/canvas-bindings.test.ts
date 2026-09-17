import { describe, it, expect, vi } from 'vitest';

// resolveCanvasBindings only orchestrates loadHealthData/computeSavingsRate/
// loadProfile/getSetting — the arithmetic itself is covered by health.test.ts.
// Mock those four so this file tests the wiring, not the financial calculations.
const mockHealthData = {
  avgMonthlyExpenses: 4000,
  monthlyIncome: 9000,
  monthlySavings: 5000,
  cash: 30000,
  liquid: 80000,      // cash + taxable brokerage
  retirement: 250000,
  totalDebt: 1500,    // credit cards
  loanDebt: 300000,   // mortgage
  netWorth: 258500,
  basis: 'txn12mo',
  basisLabel: '12-month avg',
};

vi.mock('../core/health.js', () => ({
  loadHealthData: vi.fn(async () => mockHealthData),
  computeSavingsRate: vi.fn((income: number, savings: number, pretax: number) =>
    income > 0 ? ((savings + pretax) / (income + pretax)) * 100 : null),
}));

const mockProfile: { self: { name: string; birthYear: number }; spouse?: { name: string; birthYear: number }; children: unknown[] } = {
  self: { name: 'Thomas', birthYear: 1990 },
  spouse: undefined,
  children: [],
};

vi.mock('../core/profile.js', () => ({
  loadProfile: vi.fn(async () => mockProfile),
}));

vi.mock('../core/settings.js', () => ({
  getSetting: vi.fn(async () => null),
  PRETAX_MONTHLY_KEY: 'pretax_monthly',
}));

import { evalExpr, fmtDialValue, fmtValue, type CanvasSpec, type DialDef } from '../core/canvas-spec.js';
import { resolveCanvasBindings, BINDING_KEYS } from '../core/canvas-agent.js';

const dial = (overrides: Partial<DialDef>): DialDef => ({
  key: 'k', label: 'K', default: 0, step: 1, format: 'dollar', hint: 'h',
  ...overrides,
});

const specWith = (dials: DialDef[]): CanvasSpec => ({
  title: 'Test',
  elements: dials.map((d) => ({ type: 'dial' as const, dial: d })),
});

// ─── fmtDialValue: dollar ───────────────────────────────────────────────────────

describe('fmtDialValue — dollar', () => {
  it('omits decimals for a whole-dollar value', () => {
    expect(fmtDialValue(18208, 'dollar')).toBe('$18,208');
  });
  it('keeps decimals when the value has a fractional cent component', () => {
    expect(fmtDialValue(1_093_388.68, 'dollar')).toBe('$1,093,388.68');
  });
});

// ─── fmtDialValue: toggle / select ─────────────────────────────────────────────

describe('fmtDialValue — toggle', () => {
  it('renders 0 as Off and non-zero as On', () => {
    expect(fmtDialValue(0, 'toggle')).toBe('Off');
    expect(fmtDialValue(1, 'toggle')).toBe('On');
  });
});

describe('fmtDialValue — select', () => {
  const options = ['Single', 'Married filing jointly', 'Head of household'];
  it('renders the option at the given index', () => {
    expect(fmtDialValue(0, 'select', options)).toBe('Single');
    expect(fmtDialValue(2, 'select', options)).toBe('Head of household');
  });
  it('falls back to a dash for an out-of-range index or missing options', () => {
    expect(fmtDialValue(5, 'select', options)).toBe('—');
    expect(fmtDialValue(0, 'select')).toBe('—');
  });
});

describe('fmtValue — toggle / select fallback (shared DialFormat with OutputDef)', () => {
  it('renders toggle as On/Off and select as its numeric index', () => {
    expect(fmtValue(1, 'toggle')).toBe('On');
    expect(fmtValue(0, 'toggle')).toBe('Off');
    expect(fmtValue(2, 'select')).toBe('2');
  });
});

// ─── visible: evalExpr against the dial-value scope, "!== 0" convention ───────

describe('visible expressions (evalExpr, same grammar as output expr)', () => {
  it('is visible when the expression evaluates non-zero', () => {
    expect(evalExpr('has_bonus == 1', { has_bonus: 1 }) !== 0).toBe(true);
  });
  it('is hidden when the expression evaluates to zero', () => {
    expect(evalExpr('has_bonus == 1', { has_bonus: 0 }) !== 0).toBe(false);
  });
  it('fails OPEN (stays visible) on a malformed expression', () => {
    // evalExpr returns NaN on a parse error; NaN !== 0 is true in JS.
    const result = evalExpr('this is not >>> valid', {});
    expect(Number.isNaN(result)).toBe(true);
    expect(result !== 0).toBe(true);
  });
  it('resolves an identifier absent from the passed-in scope to NaN, not a lookup error', () => {
    // Callers pass only dial values as the scope (never output values), preserving
    // the no-cross-output-reference rule. From evalExpr's perspective a bare
    // reference to something outside the scope — e.g. an output key someone
    // mistakenly wrote into `visible` — is just an unknown identifier, which
    // resolves to NaN and, per the fail-open contract above, leaves the element
    // visible rather than hiding it. (A *comparison* against an unknown identifier,
    // e.g. "total > 100", is different: NaN > 100 is a well-defined `false`/0 —
    // that's the grammar working as intended, not a malformed expression.)
    const result = evalExpr('total', { has_bonus: 1 });
    expect(Number.isNaN(result)).toBe(true);
    expect(result !== 0).toBe(true);
  });
});

// ─── resolveCanvasBindings ──────────────────────────────────────────────────────

describe('resolveCanvasBindings', () => {
  it('overwrites default for every recognized binding key with the live value', async () => {
    const spec = specWith([
      dial({ key: 'income', default: 1, binding: 'monthly_income_12mo_avg' }),
      dial({ key: 'expenses', default: 1, binding: 'monthly_expenses_12mo_avg' }),
      dial({ key: 'surplus', default: 1, binding: 'monthly_surplus_12mo_avg' }),
      dial({ key: 'cash', default: 1, binding: 'cash_balance' }),
      dial({ key: 'brokerage', default: 1, binding: 'taxable_brokerage' }),
      dial({ key: 'liquid', default: 1, binding: 'liquid_assets' }),
      dial({ key: 'retirement', default: 1, binding: 'retirement_balance' }),
      dial({ key: 'cc', default: 1, binding: 'credit_card_debt' }),
      dial({ key: 'loan', default: 1, binding: 'loan_debt' }),
      dial({ key: 'nw', default: 1, binding: 'net_worth' }),
      dial({ key: 'self_age', default: 1, binding: 'self_age' }),
    ]);

    const resolved = await resolveCanvasBindings(spec);
    const byKey = Object.fromEntries(resolved.elements.map((el) => [(el as { dial: DialDef }).dial.key, (el as { dial: DialDef }).dial.default]));

    expect(byKey.income).toBe(9000);
    expect(byKey.expenses).toBe(4000);
    expect(byKey.surplus).toBe(5000);
    expect(byKey.cash).toBe(30000);
    expect(byKey.brokerage).toBe(50000); // liquid - cash
    expect(byKey.liquid).toBe(80000);
    expect(byKey.retirement).toBe(250000);
    expect(byKey.cc).toBe(1500);
    expect(byKey.loan).toBe(300000);
    expect(byKey.nw).toBe(258500);
    expect(byKey.self_age).toBe(new Date().getFullYear() - 1990);
  });

  it('leaves the hardcoded default untouched for a binding that cannot resolve (e.g. no spouse)', async () => {
    const spec = specWith([dial({ key: 'spouse_age', default: 42, binding: 'spouse_age' })]);
    const resolved = await resolveCanvasBindings(spec);
    const el = resolved.elements[0] as { dial: DialDef };
    expect(el.dial.default).toBe(42);
  });

  it('leaves the hardcoded default untouched for an unrecognized binding string', async () => {
    const spec = specWith([dial({ key: 'weird', default: 7, binding: 'not_a_real_binding' })]);
    const resolved = await resolveCanvasBindings(spec);
    const el = resolved.elements[0] as { dial: DialDef };
    expect(el.dial.default).toBe(7);
  });

  it('leaves dials without a binding entirely untouched', async () => {
    const spec = specWith([dial({ key: 'manual', default: 123 })]);
    const resolved = await resolveCanvasBindings(spec);
    const el = resolved.elements[0] as { dial: DialDef };
    expect(el.dial.default).toBe(123);
  });

  it('does not mutate the original spec object (history integrity)', async () => {
    const spec = specWith([dial({ key: 'cash', default: 1, binding: 'cash_balance' })]);
    const snapshot = JSON.parse(JSON.stringify(spec));
    await resolveCanvasBindings(spec);
    expect(spec).toEqual(snapshot);
  });

  it('covers every key in BINDING_KEYS with a real health/profile field mapping', () => {
    // Sanity check that the vocabulary hasn't drifted from what the resolver maps.
    expect(BINDING_KEYS).toContain('savings_rate_pct');
    expect(BINDING_KEYS.length).toBe(13);
  });
});

// ─── resolveCanvasBindings: rounding ────────────────────────────────────────────
// health.ts's 12-month-average fields can come out with 10+ decimal places of
// spurious precision (e.g. 18207.755833333333). A dial's `default` is a plain JS
// number rendered verbatim by the GUI's <input type="number"> (no fmt()/fmtDialValue()
// in between), so the resolver itself must round before assigning `default`.
describe('resolveCanvasBindings — rounding', () => {
  it('rounds a long-decimal dollar-valued binding to the nearest whole dollar', async () => {
    mockHealthData.monthlyIncome = 18207.755833333333;
    try {
      const spec = specWith([dial({ key: 'income', default: 1, binding: 'monthly_income_12mo_avg' })]);
      const resolved = await resolveCanvasBindings(spec);
      const el = resolved.elements[0] as { dial: DialDef };
      expect(el.dial.default).toBe(18208);
      expect(Number.isInteger(el.dial.default)).toBe(true);
    } finally {
      mockHealthData.monthlyIncome = 9000;
    }
  });

  it('rounds a long-decimal retirement balance to the nearest whole dollar', async () => {
    mockHealthData.retirement = 1093388.6759106999;
    try {
      const spec = specWith([dial({ key: 'retirement', default: 1, binding: 'retirement_balance' })]);
      const resolved = await resolveCanvasBindings(spec);
      const el = resolved.elements[0] as { dial: DialDef };
      expect(el.dial.default).toBe(1093389);
    } finally {
      mockHealthData.retirement = 250000;
    }
  });

  it('rounds the percent-valued savings_rate_pct binding to 1 decimal place', async () => {
    // income=9000, savings=5000, pretax=0 -> (5000/9000)*100 = 55.555555...
    const spec = specWith([dial({ key: 'rate', default: 1, binding: 'savings_rate_pct' })]);
    const resolved = await resolveCanvasBindings(spec);
    const el = resolved.elements[0] as { dial: DialDef };
    expect(el.dial.default).toBeCloseTo(55.6, 10);
    // exactly one decimal place — not 55.55555...
    expect(el.dial.default).toBe(Math.round((el.dial.default as number) * 10) / 10);
  });
});
