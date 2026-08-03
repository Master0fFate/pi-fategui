import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  // Hosted macOS Intel runners can take more than a minute for the full native Electron journey.
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
