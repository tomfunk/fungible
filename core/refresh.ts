// Plain listener set (no node:events) so this module is bundle-portable.
const listeners = new Set<() => void>();

export function notifyChange(): void {
  for (const fn of [...listeners]) fn();
}

export function onRefresh(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
