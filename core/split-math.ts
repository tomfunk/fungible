import { addDays, getPeriodDates } from './dateUtils.js';

// Pure math for splitting joint expenses by a ratio and settling up monthly
// (#310). No db import, so the GUI renderer can use it directly.
//
// Per joint transaction: one self paid adds spouse's percentage of it to what
// spouse owes self; one spouse paid adds self's percentage of it to what self
// owes spouse. Whoever is owed more is paid the difference. Each transaction's
// share is kept in unrounded cents and only totals are rounded, so the sums add
// up one transaction at a time — settling part of a month now and the rest
// later gives the same total as settling it all at once.

export type SplitRatio = { startDate: string; selfPct: number };

export type SplitNames = { self: string; spouse: string };

/** A transaction that carries the joint tag, the settled tag, or both. */
export type SplitTxRow = {
  id: string;
  date: string;
  amount: number;         // positive = charge, negative = refund
  owner: string | null;   // owner of the transaction's account; null when unassigned
  joint: boolean;
  settled: boolean;
  pending: boolean;
  ignored: boolean;
  hidden: boolean;        // category is in hidden_categories (Transfer, Loan Payment, ...)
};

/** The part of a month covered by one ratio. */
export type RatioSlice = {
  selfPct: number;
  from: string;
  to: string;
  selfPaid: number;
  spousePaid: number;
  spouseOwesSelf: number;  // spouse's percentage of what self paid
  selfOwesSpouse: number;  // self's percentage of what spouse paid
};

export type SettleStatus = 'empty' | 'open' | 'settled' | 'top-up';

export type SettleMonth = {
  month: string;           // YYYY-MM
  from: string;
  to: string;
  jointTotal: number;      // every counted joint expense, including ones with no known payer
  selfPaid: number;
  spousePaid: number;
  slices: RatioSlice[];
  spouseOwesSelf: number;
  selfOwesSpouse: number;
  /** spouseOwesSelf − selfOwesSpouse over the whole month: > 0 spouse pays self, < 0 self pays spouse. */
  monthNet: number;
  /** Net of every transaction already tagged settled (same sign convention). */
  alreadySettled: number;
  /** Net still to settle (same sign convention). alreadySettled + toSettle = monthNet. */
  toSettle: number;
  /** Counted joint transactions that settling this month will tag. */
  tagIds: string[];
  /** Settled transactions that no longer count; settling reverses them and removes their tag. */
  untagIds: string[];
  status: SettleStatus;
  /** To-settle transactions on an account owned by neither self nor spouse. Any of these blocks settling. */
  blockedIds: string[];
  pendingCount: number;
  /** Joint-tagged transactions left out because their category is hidden. */
  hiddenCount: number;
  /** The month isn't over yet. */
  inProgress: boolean;
};

/** The ratio in effect on `date`: the latest one starting on or before it. */
export function ratioOn(date: string, ratios: SplitRatio[]): SplitRatio | null {
  let hit: SplitRatio | null = null;
  for (const r of ratios) {
    if (r.startDate <= date && (!hit || r.startDate > hit.startDate)) hit = r;
  }
  return hit;
}

/** First and last day of a YYYY-MM month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  return getPeriodDates('month', new Date(y, m - 1, 1));
}

function monthsFrom(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  for (let k = first; k <= last; ) {
    out.push(k);
    if (++m > 12) { m = 1; y += 1; }
    k = `${y}-${String(m).padStart(2, '0')}`;
  }
  return out;
}

// Round half away from zero so the amount owed doesn't depend on its direction;
// `+ 0` turns -0 into 0.
const toDollars = (cents: number) => (Math.sign(cents) * Math.round(Math.abs(cents))) / 100 + 0;

function slicesFor(from: string, to: string, ratios: SplitRatio[]): RatioSlice[] {
  const out: RatioSlice[] = [];
  for (let i = 0; i < ratios.length; i++) {
    const next = ratios[i + 1]?.startDate;
    const sFrom = ratios[i].startDate > from ? ratios[i].startDate : from;
    const sTo = next !== undefined && addDays(next, -1) < to ? addDays(next, -1) : to;
    if (sFrom <= sTo) {
      out.push({ selfPct: ratios[i].selfPct, from: sFrom, to: sTo, selfPaid: 0, spousePaid: 0, spouseOwesSelf: 0, selfOwesSpouse: 0 });
    }
  }
  return out;
}

function summarizeMonth(month: string, rows: SplitTxRow[], ratios: SplitRatio[], names: SplitNames, today: string): SettleMonth {
  const { from, to } = monthBounds(month);
  const slices = slicesFor(from, to, ratios);
  let jointC = 0, settledC = 0, toSettleC = 0;
  let pendingCount = 0, hiddenCount = 0, anySettled = false;
  const tagIds: string[] = [], untagIds: string[] = [], blockedIds: string[] = [];

  for (const r of rows) {
    if (r.pending) {
      if (r.joint) pendingCount++;
      continue;
    }
    const counts = r.joint && !r.ignored && !r.hidden;
    if (r.joint && !r.ignored && r.hidden) hiddenCount++;

    const ratio = ratioOn(r.date, ratios)!;
    const payer = r.owner === names.self ? 'self' : r.owner === names.spouse ? 'spouse' : null;
    const cents = Math.round(r.amount * 100);
    // What this transaction adds to "spouse owes self" (positive) or "self owes spouse" (negative).
    const net = payer === 'self' ? cents * (100 - ratio.selfPct) / 100
      : payer === 'spouse' ? -cents * ratio.selfPct / 100
      : 0;

    if (counts) {
      jointC += cents;
      const slice = slices.find((s) => s.from <= r.date && r.date <= s.to)!;
      if (payer === 'self') { slice.selfPaid += cents; slice.spouseOwesSelf += net; }
      if (payer === 'spouse') { slice.spousePaid += cents; slice.selfOwesSpouse -= net; }
    }
    if (r.settled) {
      anySettled = true;
      settledC += net;
    }
    if (counts && !r.settled) {
      tagIds.push(r.id);
      toSettleC += net;
      if (!payer) blockedIds.push(r.id);
    }
    if (r.settled && !counts) {
      untagIds.push(r.id);
      toSettleC -= net;
      if (!payer) blockedIds.push(r.id);
    }
  }

  const hasWork = tagIds.length > 0 || untagIds.length > 0;
  const status: SettleStatus = hasWork ? (anySettled ? 'top-up' : 'open') : (anySettled ? 'settled' : 'empty');
  const total = (k: 'selfPaid' | 'spousePaid' | 'spouseOwesSelf' | 'selfOwesSpouse') => slices.reduce((s, x) => s + x[k], 0);
  const spouseOwesC = total('spouseOwesSelf');
  const selfOwesC = total('selfOwesSpouse');

  return {
    month, from, to,
    jointTotal: toDollars(jointC),
    selfPaid: toDollars(total('selfPaid')),
    spousePaid: toDollars(total('spousePaid')),
    slices: slices.map((s) => ({
      ...s,
      selfPaid: toDollars(s.selfPaid),
      spousePaid: toDollars(s.spousePaid),
      spouseOwesSelf: toDollars(s.spouseOwesSelf),
      selfOwesSpouse: toDollars(s.selfOwesSpouse),
    })),
    spouseOwesSelf: toDollars(spouseOwesC),
    selfOwesSpouse: toDollars(selfOwesC),
    monthNet: toDollars(spouseOwesC - selfOwesC),
    alreadySettled: toDollars(settledC),
    toSettle: toDollars(toSettleC),
    tagIds, untagIds, status, blockedIds,
    pendingCount, hiddenCount,
    inProgress: today <= to,
  };
}

/**
 * One summary per month, newest first, from the month of the first ratio's
 * start through the current month (or the latest transaction's, if later).
 * Transactions dated before the first ratio aren't part of the split.
 */
export function computeSplit(rows: SplitTxRow[], ratios: SplitRatio[], names: SplitNames, today: string): SettleMonth[] {
  const sorted = [...ratios].sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (sorted.length === 0) return [];
  const first = sorted[0].startDate;
  const byMonth = new Map<string, SplitTxRow[]>();
  let last = today > first ? today : first;
  for (const r of rows) {
    if (r.date < first) continue;
    if (r.date > last) last = r.date;
    const k = r.date.slice(0, 7);
    const list = byMonth.get(k);
    if (list) list.push(r); else byMonth.set(k, [r]);
  }
  return monthsFrom(first.slice(0, 7), last.slice(0, 7))
    .reverse()
    .map((m) => summarizeMonth(m, byMonth.get(m) ?? [], sorted, names, today));
}
