/**
 * Escape LIKE metacharacters (`%`, `_`) and the escape character itself so a
 * user-supplied string matches literally. Pair with `ESCAPE '\'` in the SQL.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}
