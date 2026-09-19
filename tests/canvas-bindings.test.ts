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

import { evalExpr, computeOutputValues, projectSeries, fmtDialValue, fmtValue, type CanvasSpec, type CanvasElement, type DialDef, type OutputDef, type ProjectionSeriesDef } from '../core/canvas-spec.js';
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

// ─── 'year' format — a plain calendar year, distinct from the plural 'years' duration ─

describe('fmtValue / fmtDialValue — year', () => {
  it('renders a whole calendar year with no suffix, rounding a fractional value', () => {
    expect(fmtValue(2035, 'year')).toBe('2035');
    expect(fmtValue(2035.6, 'year')).toBe('2036');
    expect(fmtDialValue(2035, 'year')).toBe('2035');
    expect(fmtDialValue(2035.4, 'year')).toBe('2035');
  });
  it('stays distinct from the plural "years" duration format', () => {
    expect(fmtValue(5, 'years')).toBe('5 yr');
    expect(fmtValue(5, 'year')).toBe('5');
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

// ─── evalExpr — logical &&/|| (compound `visible` conditions) ─────────────────
// Before this grammar addition, a compound condition like "a == 1 && b == 1" threw
// in the lexer/parser (no `&&`/`||` token existed), was caught, and returned NaN —
// which is `!== 0`, so a `visible` field using `&&`/`||` failed OPEN (stayed
// visible) instead of hiding the element, the worst possible failure direction for
// a condition someone wrote specifically to hide something.

describe('evalExpr — && / ||', () => {
  it('&& is 1 only when both operands are truthy (nonzero)', () => {
    expect(evalExpr('1 && 1', {})).toBe(1);
    expect(evalExpr('1 && 0', {})).toBe(0);
    expect(evalExpr('0 && 1', {})).toBe(0);
    expect(evalExpr('0 && 0', {})).toBe(0);
  });

  it('|| is 1 when at least one operand is truthy (nonzero)', () => {
    expect(evalExpr('1 || 1', {})).toBe(1);
    expect(evalExpr('1 || 0', {})).toBe(1);
    expect(evalExpr('0 || 1', {})).toBe(1);
    expect(evalExpr('0 || 0', {})).toBe(0);
  });

  it('chains left-to-right across 3+ operands, not just two', () => {
    expect(evalExpr('1 && 1 && 1', {})).toBe(1);
    expect(evalExpr('1 && 1 && 0', {})).toBe(0);
    expect(evalExpr('0 || 0 || 1', {})).toBe(1);
    expect(evalExpr('0 || 0 || 0', {})).toBe(0);
  });

  it('combines with comparisons at the expected precedence (comparison binds tighter than && / ||)', () => {
    expect(evalExpr('1 == 1 && 2 == 2', {})).toBe(1);
    expect(evalExpr('1 == 1 && 2 == 3', {})).toBe(0);
    expect(evalExpr('1 == 2 || 2 == 2', {})).toBe(1);
    expect(evalExpr('1 == 2 || 2 == 3', {})).toBe(0);
  });

  it('&& binds tighter than || (standard precedence)', () => {
    // 0 || (1 && 0) === 0 || 0 === 0 — if && bound looser this would misparse
    expect(evalExpr('0 || 1 && 0', {})).toBe(0);
    // 1 || (0 && 0) === 1 || 0 === 1
    expect(evalExpr('1 || 0 && 0', {})).toBe(1);
  });

  it('composes with the ternary operator (?: still binds loosest)', () => {
    expect(evalExpr('(1 == 1 && 2 == 2) ? 100 : 200', {})).toBe(100);
    expect(evalExpr('(1 == 1 && 2 == 3) ? 100 : 200', {})).toBe(200);
  });

  it('reads dial keys from scope, same as comparison operands do', () => {
    expect(evalExpr('has_option == 1 && strategy == 1', { has_option: 1, strategy: 1 })).toBe(1);
    expect(evalExpr('has_option == 1 && strategy == 1', { has_option: 1, strategy: 0 })).toBe(0);
  });

  it('resolves the bug scenario correctly: a compound `visible` condition now hides rather than failing open', () => {
    // Before the fix this threw internally and returned NaN (`!== 0` → fails open,
    // i.e. stays visible). It must now evaluate to the correct 0 so the element
    // is correctly hidden.
    const result = evalExpr('a == 1 && b == 1', { a: 0, b: 0 });
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
    expect(result !== 0).toBe(false);
  });
});

// ─── evalExpr lists: sum_active / count (canvas issue #145, Phase 2 Effort A) ────

describe('evalExpr — sum_active(list_key.amount, year_expr)', () => {
  const lists = {
    expenses: [
      { amount: 2800, startYear: 2020, endYear: 2040 }, // mortgage
      { amount: 500, startYear: 2020 },                  // property tax, open-ended
      { amount: 450, endYear: 2028 },                    // no start bound
      { amount: 1900, startYear: 2023, endYear: 2031 },  // daycare
    ],
    empty: [] as { amount: number; startYear?: number; endYear?: number }[],
  };

  it('sums only rows whose [startYear, endYear] range contains the year', () => {
    // 2025: mortgage (active), property tax (active, no end), no-start-bound row
    // (active, ends 2028), daycare (active) → all four
    expect(evalExpr('sum_active(expenses.amount, 2025)', {}, lists)).toBe(2800 + 500 + 450 + 1900);
  });

  it('is inclusive on both the start and end year boundary', () => {
    // daycare: startYear 2023, endYear 2031 — both boundary years count
    expect(evalExpr('sum_active(expenses.amount, 2023)', {}, lists)).toBe(2800 + 500 + 450 + 1900);
    expect(evalExpr('sum_active(expenses.amount, 2031)', {}, lists)).toBe(2800 + 500 + 1900);
    expect(evalExpr('sum_active(expenses.amount, 2032)', {}, lists)).toBe(2800 + 500); // daycare drops off
  });

  it('excludes a row once the year is outside its range', () => {
    // 2050: mortgage ended 2040, no-start-bound row ended 2028, daycare ended 2031
    // → only the open-ended property-tax row remains
    expect(evalExpr('sum_active(expenses.amount, 2050)', {}, lists)).toBe(500);
  });

  it('treats a missing startYear as open at the start and a missing endYear as open-ended', () => {
    // Row with no startYear (endYear 2028): active in 1900, a year far before any
    // explicit startYear on other rows.
    expect(evalExpr('sum_active(expenses.amount, 1900)', {}, lists)).toBe(450);
    // Property tax row has no endYear: still active arbitrarily far in the future.
    expect(evalExpr('sum_active(expenses.amount, 3000)', {}, lists)).toBe(500);
  });

  it('evaluates the year argument as a full sub-expression against the normal scope', () => {
    expect(evalExpr('sum_active(expenses.amount, base_year + 5)', { base_year: 2020 }, lists)).toBe(2800 + 500 + 450 + 1900);
  });

  it('sums to 0 for a recognized but empty list', () => {
    expect(evalExpr('sum_active(empty.amount, 2025)', {}, lists)).toBe(0);
  });

  it('resolves to NaN for an unrecognized list key', () => {
    expect(Number.isNaN(evalExpr('sum_active(no_such_list.amount, 2025)', {}, lists))).toBe(true);
  });

  it('resolves to NaN for a field other than the literal "amount"', () => {
    expect(Number.isNaN(evalExpr('sum_active(expenses.startYear, 2025)', {}, lists))).toBe(true);
  });

  it('defaults `lists` to {} when omitted, so every pre-Effort-A call site keeps working', () => {
    expect(evalExpr('1 + 1', {})).toBe(2);
  });
});

describe('evalExpr — count(list_key)', () => {
  const lists = {
    expenses: [{ amount: 1 }, { amount: 2 }, { amount: 3 }],
    empty: [] as { amount: number }[],
  };

  it('counts every row unconditionally, regardless of year', () => {
    expect(evalExpr('count(expenses)', {}, lists)).toBe(3);
  });
  it('returns 0 for a recognized but empty list', () => {
    expect(evalExpr('count(empty)', {}, lists)).toBe(0);
  });
  it('resolves to NaN for an unrecognized list key', () => {
    expect(Number.isNaN(evalExpr('count(no_such_list)', {}, lists))).toBe(true);
  });
});

describe('lex — the "." punctuation token does not break decimal-literal parsing', () => {
  it('still tokenizes a leading-dot decimal as a single number', () => {
    expect(evalExpr('.5 + .5', {})).toBe(1);
  });
  it('still tokenizes an ordinary decimal correctly', () => {
    expect(evalExpr('1.5 * 2', {})).toBe(3);
  });
  it('tokenizes list_key.amount as three tokens (identifier, dot, identifier), consumed by sum_active', () => {
    expect(evalExpr('sum_active(expenses.amount, 2025)', {}, { expenses: [{ amount: 10, startYear: 2025, endYear: 2025 }] })).toBe(10);
  });
});

// ─── computeOutputValues: inter-output references (canvas issue #145, Phase 2 Effort B) ─

describe('computeOutputValues', () => {
  const out = (overrides: Partial<OutputDef> & { expr: string }): CanvasElement =>
    ({ type: 'output', output: { label: 'L', format: 'dollar', ...overrides } } as CanvasElement);

  it('resolves a later output referencing an earlier output\'s key', () => {
    const elements: CanvasElement[] = [
      out({ key: 'monthly_surplus', expr: 'income - expenses' }),
      out({ expr: 'monthly_surplus * 12' }),
    ];
    const values = computeOutputValues(elements, { income: 5000, expenses: 3000 });
    expect(values).toEqual([2000, 24000]);
  });

  it('resolves a forward reference (later key) to NaN, not a crash', () => {
    const elements: CanvasElement[] = [
      out({ expr: 'future_value' }), // references a key defined later
      out({ key: 'future_value', expr: '42' }),
    ];
    const values = computeOutputValues(elements, {});
    expect(values.length).toBe(2);
    expect(Number.isNaN(values[0])).toBe(true);
    expect(values[1]).toBe(42);
  });

  it('resolves a reference to a nonexistent key to NaN, not a crash', () => {
    const elements: CanvasElement[] = [out({ expr: 'no_such_key + 1' })];
    const values = computeOutputValues(elements, {});
    expect(Number.isNaN(values[0])).toBe(true);
  });

  it('computes a hidden (visible: false) output\'s value regardless — visible is render-only', () => {
    // computeOutputValues takes the full, unfiltered elements array and never looks
    // at `visible` at all; callers are responsible for filtering what to *render*,
    // not what to *compute*. A later output can still reference a hidden earlier
    // output's key.
    const elements: CanvasElement[] = [
      { type: 'output', output: { key: 'hidden_val', label: 'Hidden', expr: '10', format: 'dollar' }, visible: '0' },
      out({ expr: 'hidden_val * 2' }),
    ];
    const values = computeOutputValues(elements, {});
    expect(values).toEqual([10, 20]);
  });

  it('returns every output\'s value in original array order, including non-output elements interspersed', () => {
    const elements: CanvasElement[] = [
      { type: 'section', label: 'RESULTS' },
      out({ expr: '1 + 1' }),
      { type: 'text', content: 'note' },
      out({ expr: '2 + 2' }),
    ];
    const values = computeOutputValues(elements, {});
    expect(values).toEqual([2, 4]);
  });

  it('does not add an output without a key to the lookup scope, but still returns its own value', () => {
    const elements: CanvasElement[] = [
      out({ expr: '5' }), // no key — not referenceable
      out({ expr: 'typeof_missing_ref' }), // would-be reference to the keyless output above; unresolvable
    ];
    const values = computeOutputValues(elements, {});
    expect(values[0]).toBe(5);
    expect(Number.isNaN(values[1])).toBe(true);
  });

  it('shares one flat scope between dial values and earlier output values', () => {
    const elements: CanvasElement[] = [
      out({ key: 'doubled', expr: 'base * 2' }),
      out({ expr: 'doubled + base' }),
    ];
    const values = computeOutputValues(elements, { base: 10 });
    expect(values).toEqual([20, 30]);
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

// ─── projectSeries: chart/table output (canvas issue #145, Phase 2 Effort C) ────

describe('projectSeries', () => {
  const yearDial = (overrides: Partial<DialDef>): CanvasElement => ({
    type: 'dial',
    dial: { key: 'year', label: 'Year', default: 2026, step: 1, format: 'year', hint: 'h', ...overrides },
  });

  const series: ProjectionSeriesDef[] = [
    { label: 'Value', expr: 'year * 2', format: 'dollar' },
  ];

  it('produces one point per step across the driver dial\'s min/max/step, evaluating expr at each step', () => {
    const elements = [yearDial({ min: 2020, max: 2024, step: 1 })];
    const points = projectSeries(elements, {}, {}, 'year', series);
    expect(points).toEqual([
      { x: 2020, values: [4040] },
      { x: 2021, values: [4042] },
      { x: 2022, values: [4044] },
      { x: 2023, values: [4046] },
      { x: 2024, values: [4048] },
    ]);
  });

  it('resolves sum_active/count against a fixture list at each step', () => {
    const elements = [yearDial({ min: 2025, max: 2027, step: 1 })];
    const lists = {
      expenses: [
        { amount: 2800, startYear: 2020, endYear: 2026 },
        { amount: 500, startYear: 2027 },
      ],
    };
    const listSeries: ProjectionSeriesDef[] = [
      { label: 'Active', expr: 'sum_active(expenses.amount, year)', format: 'dollar' },
      { label: 'Count', expr: 'count(expenses)', format: 'integer' },
    ];
    const points = projectSeries(elements, {}, lists, 'year', listSeries);
    expect(points).toEqual([
      { x: 2025, values: [2800, 2] },
      { x: 2026, values: [2800, 2] }, // inclusive end boundary
      { x: 2027, values: [500, 2] },  // mortgage dropped off, pension starts
    ]);
  });

  it('mixes in fixed dial values from the passed-in scope alongside the driver', () => {
    const elements = [yearDial({ min: 2020, max: 2021, step: 1 })];
    const withBase: ProjectionSeriesDef[] = [{ label: 'V', expr: 'base + year', format: 'dollar' }];
    const points = projectSeries(elements, { base: 10 }, {}, 'year', withBase);
    expect(points).toEqual([
      { x: 2020, values: [2030] },
      { x: 2021, values: [2031] },
    ]);
  });

  it('returns [] when the driver key does not match any dial element', () => {
    const elements = [yearDial({ min: 2020, max: 2024, step: 1 })];
    expect(projectSeries(elements, {}, {}, 'no_such_dial', series)).toEqual([]);
  });

  it('returns [] when the driver dial is missing min or max', () => {
    const noMin = [{ type: 'dial' as const, dial: { key: 'year', label: 'Year', default: 2026, step: 1, max: 2030, format: 'year' as const, hint: 'h' } }];
    const noMax = [{ type: 'dial' as const, dial: { key: 'year', label: 'Year', default: 2026, step: 1, min: 2020, format: 'year' as const, hint: 'h' } }];
    expect(projectSeries(noMin, {}, {}, 'year', series)).toEqual([]);
    expect(projectSeries(noMax, {}, {}, 'year', series)).toEqual([]);
  });

  it('returns [] when step is zero or negative', () => {
    const elements = [yearDial({ min: 2020, max: 2024, step: 0 })];
    expect(projectSeries(elements, {}, {}, 'year', series)).toEqual([]);
    const elementsNeg = [yearDial({ min: 2020, max: 2024, step: -1 })];
    expect(projectSeries(elementsNeg, {}, {}, 'year', series)).toEqual([]);
  });

  it('returns [] when max < min', () => {
    const elements = [yearDial({ min: 2030, max: 2020, step: 1 })];
    expect(projectSeries(elements, {}, {}, 'year', series)).toEqual([]);
  });

  it('caps at 120 points, resampling to span the full [min, max] range rather than truncating the tail', () => {
    // 1000 raw steps (0..999 inclusive by step 1) would exceed the 120-point cap.
    const elements = [yearDial({ min: 2000, max: 2999, step: 1 })];
    const points = projectSeries(elements, {}, {}, 'year', series);
    expect(points.length).toBe(120);
    expect(points[0].x).toBe(2000);
    // Last point must land exactly on `max`, not cut off well before it.
    expect(points[points.length - 1].x).toBe(2999);
    // Evenly spaced across the full range, not clustered near the start.
    expect(points[1].x - points[0].x).toBeCloseTo((2999 - 2000) / 119, 6);
  });

  it('does not resample when the raw step count is exactly at the cap', () => {
    // min=0, max=119, step=1 -> exactly 120 raw points.
    const elements = [yearDial({ min: 0, max: 119, step: 1 })];
    const points = projectSeries(elements, {}, {}, 'year', series);
    expect(points.length).toBe(120);
    expect(points.map((p) => p.x)).toEqual(Array.from({ length: 120 }, (_, i) => i));
  });

  it('resolves a series expr referencing an output key (not a dial/list) to NaN, same as any unknown identifier', () => {
    const elements = [yearDial({ min: 2020, max: 2021, step: 1 })];
    const outputRefSeries: ProjectionSeriesDef[] = [
      { label: 'Bad', expr: 'some_output_key + year', format: 'dollar' },
    ];
    const points = projectSeries(elements, {}, {}, 'year', outputRefSeries);
    expect(points.length).toBe(2);
    for (const p of points) {
      expect(Number.isNaN(p.values[0])).toBe(true);
    }
  });
});
