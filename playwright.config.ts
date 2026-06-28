import { defineConfig } from '@playwright/test';

// Electron launch / boot e2e tests. These launch the real packaged main process
// (electron-vite build output in out/) — see tests/e2e/. Run serially: each test
// boots its own Electron process against an isolated temp data dir and shares a
// single display, so parallelism buys nothing and only adds flake.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
});
