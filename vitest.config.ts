import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
