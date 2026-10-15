// Portable (no node:* imports): the dedup key + ordinal logic, split out of
// csv.ts so the browser bundle can use it without pulling in fs/path/crypto.

/**
 * The idempotency key for a CSV transaction, scoped to an account by the unique
 * index on (account_id, dedup_key) rather than by being baked into the key.
 *
 * `ord` is the occurrence index of an otherwise identical (date, name, amount)
 * tuple *within the file being imported*. It is what allows two real $4.50
 * coffees on the same day to both land, while re-importing an overlapping
 * statement still recognises the rows it has already seen: the same file always
 * produces the same ordinals.
 *
 * Amount is reduced to integer cents rather than interpolated as a float, so the
 * key never depends on how a language happens to render 5.0 versus 5.
 */
export function dedupKey(date: string, name: string, amount: number, ord: number): string {
  return `${date}|${name.trim().toLowerCase()}|${Math.round(amount * 100)}|${ord}`;
}

/** Numbers each row with its occurrence index among identical rows, in file order. */
export function assignOrdinals<T extends { date: string; name: string; amount: number }>(
  rows: T[],
): (T & { ord: number })[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const bucket = dedupKey(r.date, r.name, r.amount, 0);
    const ord = seen.get(bucket) ?? 0;
    seen.set(bucket, ord + 1);
    return { ...r, ord };
  });
}
