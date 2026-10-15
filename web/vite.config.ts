import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Plain Vite (not electron-vite) — the browser build of the app. `npm run
// web` runs `vite web` from the repo root, so this file's directory (web/)
// becomes the Vite root and web/index.html is the entry.
//
// The renderer UI itself is NOT duplicated here: web/src/main.tsx imports
// gui/renderer/src/App.tsx directly, which lives outside this root, hence
// the explicit fs.allow below. envDir points back at the repo root so a
// VITE_FUNGIBLE_SYNC_URL var can live in the same top-level .env as everything
// else instead of a second .env file just for this app.
export default defineConfig({
  plugins: [react()],
  envDir: resolve(import.meta.dirname, '..'),
  resolve: {
    alias: [
      { find: /^(.*)\/snapshot\.js$/, replacement: resolve(import.meta.dirname, 'src/shims/snapshot.ts') },
      // Every core/*.ts module imports the DB as `from './db.js'` (relative
      // path varies by depth, always ending `db.js`) and never touches the
      // platform split itself — redirect that one specifier to
      // core/db.browser.ts (vassal-core's @libsql/client-wasm + OPFS
      // implementation) for this build only. core/db.ts (the Node path) is
      // unaffected. See core/db.browser.ts's own header comment for the
      // matching note from core's side.
      { find: /^(.*)\/db\.js$/, replacement: resolve(import.meta.dirname, '../core/db.browser.ts') },
    ],
  },
  // @libsql/client-wasm ships a .wasm file loaded via a relative URL inside
  // its own package. Vite's dep pre-bundler (esbuild) rewrites that request
  // to node_modules/.vite/deps/sqlite3.wasm without actually emitting the
  // file there, so the dev server 404s and its SPA/history fallback returns
  // index.html instead — the browser then tries to WebAssembly.compile HTML
  // ("Incorrect response MIME type. Expected 'application/wasm'"). Excluding
  // the package from pre-bundling sidesteps this: it's served as its own ESM
  // module instead, where the relative wasm URL resolves normally. The same
  // goes for @libsql/libsql-wasm-experimental, the build the database worker
  // (core/db.browser.worker.ts) actually loads. Found by
  // actually running `npm run web` under a headless browser and reading the
  // console/network errors (see the `run` skill) — not guessed at.
  optimizeDeps: {
    exclude: ['@libsql/client-wasm', '@libsql/libsql-wasm-experimental'],
  },
  server: {
    port: 5174, // electron-vite's renderer dev server already uses 5173
    fs: {
      allow: [resolve(import.meta.dirname, '..')],
    },
  },
});
