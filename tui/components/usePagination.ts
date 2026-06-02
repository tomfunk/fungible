/** Returns the visible slice of items centered on cursor, and the index of the first visible item. */
export function usePagination<T>(items: T[], cursor: number, pageSize: number): { visible: T[]; pageStart: number } {
  const pageStart = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), items.length - pageSize));
  const visible = items.slice(pageStart, pageStart + pageSize);
  return { visible, pageStart };
}
