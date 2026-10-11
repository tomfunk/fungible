import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Default data dir for every test worker. core/crypto.ts lazily creates its key
// file in DATA_DIR, so without this a test that encrypts a token (seedPlaidItem)
// would read or write the developer's real ~/.fungible/key, and fail on a fresh
// CI box where that directory does not exist. Tests that need their own dir
// still set FUNGIBLE_DATA_DIR before importing core, which overrides this.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'fungible-vitest-'));

export default defineConfig({
  test: {
    env: { FUNGIBLE_DATA_DIR: DATA_DIR },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Reporting only, no thresholds. Used with `vitest run --coverage` once
    // @vitest/coverage-v8 is installed; ignored otherwise.
    coverage: {
      provider: 'v8',
      include: ['core/**', 'api/**', 'mcp/**', 'tui/**', 'gui/**'],
      exclude: ['**/*.d.ts', 'gui/**/*.css', 'gui/**/*.html', 'tests/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
    },
  },
});
