import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildFilterConditions, buildFilterClause, mergeFilters,
  isFilterActive, filterSummary, selectionToDim, selectionFromDim,
  invertSelection, invertTagModes, filtersEqual,
  pushFilter, popFilter, MAX_FILTER_HISTORY,
  type Filter, type FilterHistory,
} from '../core/filters.js';

// ── Pure clause-builder tests (no database) ────────────────────────────────────

describe('buildFilterConditions', () => {
  it('returns nothing for undefined or empty filter', () => {
    expect(buildFilterConditions(undefined, 't')).toEqual({ conditions: [], args: [] });
    expect(buildFilterConditions({}, 't')).toEqual({ conditions: [], args: [] });
  });

  it('builds an IN list for categories with one placeholder per value', () => {
    const { conditions, args } = buildFilterConditions({ categories: ['Rent', 'Dining'] }, 't');
    expect(conditions).toEqual(['t.category IN (?, ?)']);
    expect(args).toEqual(['Rent', 'Dining']);
  });

  it('builds an IN list for accounts using the given alias', () => {
    const { conditions, args } = buildFilterConditions({ accounts: ['a1'] }, 'transactions');
    expect(conditions).toEqual(['transactions.account_id IN (?)']);
    expect(args).toEqual(['a1']);
  });

  it('resolves owners through an accounts subquery, normalizing Unassigned', () => {
    const { conditions, args } = buildFilterConditions({ owners: ['Mark', 'Unassigned'] }, 't');
    expect(conditions[0]).toContain('t.account_id IN (SELECT id FROM accounts WHERE');
    expect(conditions[0]).toContain("COALESCE(NULLIF(TRIM(owner), ''), 'Unassigned') IN (?, ?)");
    expect(args).toEqual(['Mark', 'Unassigned']);
  });

  it('emits EXISTS for has and NOT EXISTS for lacks, one per tag predicate', () => {
    const { conditions, args } = buildFilterConditions(
      { tags: [{ name: 'shared', mode: 'has' }, { name: 'personal', mode: 'lacks' }] },
      't',
    );
    expect(conditions[0].startsWith('EXISTS')).toBe(true);
    expect(conditions[0]).toContain('tt.transaction_id = t.id');
    expect(conditions[1].startsWith('NOT EXISTS')).toBe(true);
    expect(args).toEqual(['shared', 'personal']);
  });

  it('treats a present-but-empty dimension as match-nothing (1 = 0)', () => {
    expect(buildFilterConditions({ categories: [] }, 't').conditions).toEqual(['1 = 0']);
    expect(buildFilterConditions({ accounts: [] }, 't').conditions).toEqual(['1 = 0']);
    expect(buildFilterConditions({ owners: [] }, 't').conditions).toEqual(['1 = 0']);
  });

  it('ANDs multiple dimensions together', () => {
    const { conditions, args } = buildFilterConditions(
      { categories: ['Rent'], accounts: ['a1'] }, 't',
    );
    expect(conditions).toEqual(['t.category IN (?)', 't.account_id IN (?)']);
    expect(args).toEqual(['Rent', 'a1']);
  });
});

describe('buildFilterClause', () => {
  it('prefixes a spliceable AND clause, or empty string when unconstrained', () => {
    expect(buildFilterClause(undefined, 't').clause).toBe('');
    expect(buildFilterClause({ categories: ['Rent'] }, 't').clause).toBe(' AND t.category IN (?)');
  });
});

describe('mergeFilters', () => {
  it('uses whichever side constrains a dimension when the other does not', () => {
    expect(mergeFilters({}, { categories: ['A'] })).toEqual({ categories: ['A'] });
    expect(mergeFilters({ accounts: ['a1'] }, undefined)).toEqual({ accounts: ['a1'] });
    expect(mergeFilters(undefined, { accounts: ['a1'] })).toEqual({ accounts: ['a1'] });
  });

  it('intersects set dimensions constrained on both sides', () => {
    expect(mergeFilters({ categories: ['A', 'B'] }, { categories: ['B', 'C'] }))
      .toEqual({ categories: ['B'] });
  });

  it('concatenates tag predicates from both sides', () => {
    const merged = mergeFilters(
      { tags: [{ name: 'x', mode: 'has' }] },
      { tags: [{ name: 'y', mode: 'lacks' }] },
    );
    expect(merged.tags).toEqual([{ name: 'x', mode: 'has' }, { name: 'y', mode: 'lacks' }]);
  });
});

describe('isFilterActive / filterSummary', () => {
  it('is inactive for empty/undefined and for tag-only empty arrays', () => {
    expect(isFilterActive(undefined)).toBe(false);
    expect(isFilterActive({})).toBe(false);
    expect(isFilterActive({ tags: [] })).toBe(false);
  });

  it('is active when any set dimension is present, even when empty', () => {
    expect(isFilterActive({ categories: [] })).toBe(true);
    expect(isFilterActive({ accounts: ['a1'] })).toBe(true);
    expect(isFilterActive({ tags: [{ name: 'x', mode: 'has' }] })).toBe(true);
  });

  it('summarizes active dimensions with correct pluralization', () => {
    expect(filterSummary({ accounts: ['a1', 'a2'], categories: ['Rent'] }))
      .toBe('2 accounts, 1 category');
    expect(filterSummary({})).toBe('');
  });
});

describe('selectionToDim / selectionFromDim (panel serialization)', () => {
  const universe = ['Rent', 'Dining', 'Shopping'];

  it('serializes a fully-selected universe to undefined (no constraint)', () => {
    expect(selectionToDim(new Set(universe), universe)).toBeUndefined();
  });

  it('serializes a partial selection to the member list', () => {
    expect(selectionToDim(new Set(['Rent', 'Dining']), universe)?.sort()).toEqual(['Dining', 'Rent']);
  });

  it('serializes an empty selection to [] (match nothing)', () => {
    expect(selectionToDim(new Set(), universe)).toEqual([]);
  });

  it('treats an empty universe as no constraint', () => {
    expect(selectionToDim(new Set(), [])).toBeUndefined();
  });

  it('hydrates undefined to the full universe and a list back to itself', () => {
    expect(selectionFromDim(undefined, universe)).toEqual(new Set(universe));
    expect(selectionFromDim(['Rent'], universe)).toEqual(new Set(['Rent']));
    expect(selectionFromDim([], universe)).toEqual(new Set());
  });

  it('round-trips a partial selection', () => {
    const sel = selectionFromDim(['Dining'], universe);
    expect(selectionToDim(sel, universe)).toEqual(['Dining']);
  });
});

describe('invertSelection', () => {
  const universe = ['Rent', 'Dining', 'Shopping'];

  it('complements a partial selection against the universe', () => {
    expect(invertSelection(new Set(['Rent']), universe)).toEqual(new Set(['Dining', 'Shopping']));
  });

  it('maps full to empty and empty to full', () => {
    expect(invertSelection(new Set(universe), universe)).toEqual(new Set());
    expect(invertSelection(new Set(), universe)).toEqual(new Set(universe));
  });
});

describe('invertTagModes', () => {
  it('swaps has and lacks; off (absent) tags stay off', () => {
    const inverted = invertTagModes(new Map([['shared', 'has'], ['personal', 'lacks']]));
    expect(inverted).toEqual(new Map([['shared', 'lacks'], ['personal', 'has']]));
    expect(inverted.has('untouched')).toBe(false);
  });
});

describe('filtersEqual', () => {
  it('treats empty, undefined, and absent dimensions as equal', () => {
    expect(filtersEqual({}, {})).toBe(true);
    expect(filtersEqual(undefined, {})).toBe(true);
    expect(filtersEqual({ categories: undefined }, {})).toBe(true);
  });

  it('distinguishes undefined (unconstrained) from [] (match nothing)', () => {
    expect(filtersEqual({ categories: [] }, {})).toBe(false);
    expect(filtersEqual({ categories: [] }, { categories: [] })).toBe(true);
  });

  it('compares set dimensions order-insensitively', () => {
    expect(filtersEqual({ categories: ['A', 'B'] }, { categories: ['B', 'A'] })).toBe(true);
    expect(filtersEqual({ categories: ['A'] }, { categories: ['A', 'B'] })).toBe(false);
  });

  it('compares tags by name and mode, order-insensitively', () => {
    const a: Filter = { tags: [{ name: 'x', mode: 'has' }, { name: 'y', mode: 'lacks' }] };
    const b: Filter = { tags: [{ name: 'y', mode: 'lacks' }, { name: 'x', mode: 'has' }] };
    expect(filtersEqual(a, b)).toBe(true);
    expect(filtersEqual(a, { tags: [{ name: 'x', mode: 'lacks' }, { name: 'y', mode: 'lacks' }] })).toBe(false);
  });
});

describe('pushFilter / popFilter (filter history)', () => {
  const empty: FilterHistory = { current: {}, stack: [] };

  it('pushes the previous current onto the stack', () => {
    const h = pushFilter(empty, { categories: ['Rent'] });
    expect(h.current).toEqual({ categories: ['Rent'] });
    expect(h.stack).toEqual([{}]);
  });

  it('skips deep-equal no-op sets, including reordered arrays', () => {
    const h = pushFilter(empty, { categories: ['A', 'B'] });
    expect(pushFilter(h, { categories: ['B', 'A'] })).toBe(h);
    expect(pushFilter(empty, {})).toBe(empty);
  });

  it('caps the stack, dropping the oldest entries', () => {
    let h = empty;
    for (let i = 0; i < MAX_FILTER_HISTORY + 5; i++) {
      h = pushFilter(h, { categories: [`c${i}`] });
    }
    expect(h.stack).toHaveLength(MAX_FILTER_HISTORY);
    expect(h.stack[0]).toEqual({ categories: ['c4'] });
  });

  it('pop restores the top of the stack one level at a time', () => {
    let h = pushFilter(empty, { categories: ['A'] });
    h = pushFilter(h, { categories: ['B'] });
    h = pushFilter(h, { categories: ['C'] });
    h = popFilter(h);
    expect(h.current).toEqual({ categories: ['B'] });
    h = popFilter(h);
    expect(h.current).toEqual({ categories: ['A'] });
  });

  it('pop with an empty stack clears an active filter, no-ops on an inactive one', () => {
    const active: FilterHistory = { current: { categories: ['A'] }, stack: [] };
    expect(popFilter(active).current).toEqual({});
    const inactive: FilterHistory = { current: {}, stack: [] };
    expect(popFilter(inactive)).toBe(inactive);
  });
});

// ── Database-backed integration tests ──────────────────────────────────────────

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

const { db } = await import('../core/db.js');
const { getTransactions, getRangeSummary, getFilterOptions, getAccountRows, getOwnerRows } = await import('../core/queries.js');
const { getPeriodTotals } = await import('../core/trends.js');

let txId = 0;
async function insertTx(opts: { amount: number; category?: string; accountId?: string; date?: string }) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    args: [`tx${txId}`, opts.accountId ?? 'a1', opts.date ?? '2025-01-15', 'Tx', opts.amount, opts.category ?? 'Shopping'],
  });
  return `tx${txId}`;
}
const addAccount = (id: string, owner: string | null) =>
  db.execute({ sql: "INSERT INTO accounts (id, name, type, owner) VALUES (?, ?, 'depository', ?)", args: [id, id, owner] });
async function tagTx(txId: string, tagName: string) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO tags (name) VALUES (?)', args: [tagName] });
  const r = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [tagName] });
  const tagId = (r.rows[0] as unknown as { id: number }).id;
  await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [txId, tagId] });
}

beforeEach(async () => {
  txId = 0;
  for (const t of ['transaction_tags', 'tags', 'transactions', 'accounts', 'hidden_categories', 'categories']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

describe('getTransactions with a Filter', () => {
  it('restricts to the selected categories (OR within the dimension)', async () => {
    await insertTx({ category: 'Rent', amount: 100 });
    await insertTx({ category: 'Dining', amount: 50 });
    await insertTx({ category: 'Shopping', amount: 25 });
    const rows = await getTransactions({ filter: { categories: ['Rent', 'Dining'] } });
    expect(rows.map((r) => r.category).sort()).toEqual(['Dining', 'Rent']);
  });

  it('restricts to the selected accounts', async () => {
    await insertTx({ accountId: 'a1', amount: 100 });
    await insertTx({ accountId: 'a2', amount: 200 });
    const rows = await getTransactions({ filter: { accounts: ['a1'] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(100);
  });

  it('restricts by owner — Chase txns owned by Mark (account AND owner)', async () => {
    await addAccount('chase', 'Mark');
    await addAccount('amex', 'Mark');
    await addAccount('joint', 'Partner');
    await insertTx({ accountId: 'chase', amount: 10 });
    await insertTx({ accountId: 'amex', amount: 20 });
    await insertTx({ accountId: 'joint', amount: 30 });
    const rows = await getTransactions({ filter: { owners: ['Mark'], accounts: ['chase'] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(10);
  });

  it('buckets owner-less accounts under Unassigned', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', null);
    await insertTx({ accountId: 'a1', amount: 10 });
    await insertTx({ accountId: 'a2', amount: 20 });
    const rows = await getTransactions({ filter: { owners: ['Unassigned'] } });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(20);
  });

  it('filters by tag presence (has) and absence (lacks)', async () => {
    const t1 = await insertTx({ amount: 10 });
    await insertTx({ amount: 20 });
    await tagTx(t1, 'personal');
    expect((await getTransactions({ filter: { tags: [{ name: 'personal', mode: 'has' }] } }))
      .map((r) => r.amount)).toEqual([10]);
    expect((await getTransactions({ filter: { tags: [{ name: 'personal', mode: 'lacks' }] } }))
      .map((r) => r.amount)).toEqual([20]);
  });

  it('ANDs multiple tag predicates: has shared AND lacks personal', async () => {
    const t1 = await insertTx({ amount: 10 });
    const t2 = await insertTx({ amount: 20 });
    await tagTx(t1, 'shared');
    await tagTx(t2, 'shared'); await tagTx(t2, 'personal');
    const rows = await getTransactions({
      filter: { tags: [{ name: 'shared', mode: 'has' }, { name: 'personal', mode: 'lacks' }] },
    });
    expect(rows.map((r) => r.amount)).toEqual([10]);
  });

  it('returns nothing for an explicitly-empty dimension', async () => {
    await insertTx({ amount: 10 });
    expect(await getTransactions({ filter: { categories: [] } })).toHaveLength(0);
  });
});

describe('getRangeSummary with a Filter', () => {
  it('applies category and tag constraints to the headline totals', async () => {
    const t1 = await insertTx({ category: 'Dining', amount: 100 });
    await insertTx({ category: 'Rent', amount: 400 });
    await tagTx(t1, 'personal');
    const all = await getRangeSummary('2025-01-01', '2025-01-31');
    expect(all.expenses).toBeCloseTo(500);
    const noPersonal = await getRangeSummary('2025-01-01', '2025-01-31', { tags: [{ name: 'personal', mode: 'lacks' }] });
    expect(noPersonal.expenses).toBeCloseTo(400);
  });
});

describe('getAccountRows with a Filter', () => {
  it('honors other dimensions but keeps a row per account', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', 'Sam');
    await insertTx({ accountId: 'a1', category: 'Dining', amount: 100 });
    await insertTx({ accountId: 'a1', category: 'Rent', amount: 400 });
    await insertTx({ accountId: 'a2', category: 'Dining', amount: 50 });

    const dining = await getAccountRows('2025-01-01', '2025-01-31', { categories: ['Dining'] });
    expect(dining.find((r) => r.id === 'a1')?.spending).toBeCloseTo(100);
    expect(dining.find((r) => r.id === 'a2')?.spending).toBeCloseTo(50);
  });

  it('ignores its own accounts dimension so the picker keeps every row', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', 'Sam');
    await insertTx({ accountId: 'a1', amount: 100 });
    await insertTx({ accountId: 'a2', amount: 50 });

    const rows = await getAccountRows('2025-01-01', '2025-01-31', { accounts: ['a1'] });
    expect(rows.find((r) => r.id === 'a2')?.spending).toBeCloseTo(50);
  });
});

describe('getOwnerRows with a Filter', () => {
  it('honors category and tag constraints (the spouse-split use case)', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', 'Sam');
    const t1 = await insertTx({ accountId: 'a1', category: 'Dining', amount: 100 });
    await insertTx({ accountId: 'a1', category: 'Rent', amount: 400 });
    await insertTx({ accountId: 'a2', category: 'Dining', amount: 50 });
    await tagTx(t1, 'personal');

    const dining = await getOwnerRows('2025-01-01', '2025-01-31', { categories: ['Dining'] });
    expect(dining.find((r) => r.owner === 'Mark')?.spending).toBeCloseTo(100);
    expect(dining.find((r) => r.owner === 'Sam')?.spending).toBeCloseTo(50);

    const noPersonal = await getOwnerRows('2025-01-01', '2025-01-31', { tags: [{ name: 'personal', mode: 'lacks' }] });
    expect(noPersonal.find((r) => r.owner === 'Mark')?.spending).toBeCloseTo(400);
    expect(noPersonal.find((r) => r.owner === 'Sam')?.spending).toBeCloseTo(50);
  });

  it('ignores its own owners dimension since it groups by owner', async () => {
    await addAccount('a1', 'Mark');
    await addAccount('a2', 'Sam');
    await insertTx({ accountId: 'a1', amount: 100 });
    await insertTx({ accountId: 'a2', amount: 50 });

    const rows = await getOwnerRows('2025-01-01', '2025-01-31', { owners: ['Mark'] });
    expect(rows.find((r) => r.owner === 'Sam')?.spending).toBeCloseTo(50);
  });
});

describe('getPeriodTotals with a Filter', () => {
  it('restricts the trend series to the selected accounts', async () => {
    await insertTx({ accountId: 'a1', amount: 100, date: '2025-01-10' });
    await insertTx({ accountId: 'a2', amount: 250, date: '2025-01-20' });
    const view = { mode: 'expenses' as const, category: null, flex: null, label: 'Expenses' };
    const all = await getPeriodTotals(view, 'month');
    expect(all.find((p) => p.from === '2025-01-01')?.total).toBeCloseTo(350);
    const a1 = await getPeriodTotals(view, 'month', { accounts: ['a1'] });
    expect(a1.find((p) => p.from === '2025-01-01')?.total).toBeCloseTo(100);
  });
});

describe('getFilterOptions', () => {
  it('returns categories, accounts (with owner), distinct owners, and tags', async () => {
    await db.execute("INSERT INTO categories (name) VALUES ('Rent'), ('Dining')");
    await addAccount('chase', 'Mark');
    await addAccount('amex', 'Mark');
    await addAccount('joint', null); // null owner → Unassigned bucket
    const tx = await insertTx({ accountId: 'chase', amount: 10 });
    await tagTx(tx, 'shared');

    const opts = await getFilterOptions();
    expect(opts.categories).toEqual(['Dining', 'Rent']); // alphabetical
    expect(opts.accounts).toEqual([
      { id: 'amex', name: 'amex', owner: 'Mark' },
      { id: 'chase', name: 'chase', owner: 'Mark' },
      { id: 'joint', name: 'joint', owner: 'Unassigned' },
    ]);
    expect(opts.owners).toEqual(['Mark', 'Unassigned']); // distinct, sorted
    expect(opts.tags).toEqual(['shared']);
  });
});
