// core/snapshot.ts is Node-only (files on disk). The browser database has
// nothing on disk to protect, and every browser call site passes
// `snapshot: false`; this stand-in (aliased in web/vite.config.ts) exists so
// the lazy `import('./snapshot.js')` in core/migrate.ts and core/sync-adopt.ts
// bundles, and fails loudly if a code path ever reaches it.
export async function snapshot(): Promise<never> {
  throw new Error('Snapshots are not available in the browser build.');
}
