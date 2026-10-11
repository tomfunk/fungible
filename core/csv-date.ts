// Pure, browser-safe date parsing (no node imports) so the gui renderer can
// import it; core/csv.ts re-exports it for existing importers.

/** Normalise ISO or M/D/Y to a valid ISO date; null when unparseable or not a
 *  real calendar date. D/M order is not supported. */
export function parseDate(raw: string): string | null {
  const s = (raw ?? '').trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (match) {
    [y, m, d] = [+match[1], +match[2], +match[3]];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    m = +match[1]; d = +match[2];
    y = match[3].length === 2 ? (+match[3] < 50 ? 2000 : 1900) + +match[3] : +match[3];
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(y); // Date.UTC maps years 0-99 to 1900s
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
