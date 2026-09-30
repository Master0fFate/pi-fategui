import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (!process.env.FATE_V2_TEST_ROOT || !process.env.FATE_WEB_CHROMIUM_EXECUTABLE || !process.env.FATE_WEB_DENY_PROXY) {
  throw new Error('Run node scripts/run-web-tests.mjs with an installed PLAYWRIGHT_BROWSERS_PATH; no download fallback is permitted.');
}

export default defineConfig({
  testDir: 'tests/web', testMatch: '*.spec.ts', workers: 1, fullyParallel: false,
  retries: 0, timeout: 90_000, expect: { timeout: 12_000 },
  outputDir: path.resolve('test-results/web'), reporter: [['list']],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
    // fixture.ts owns tracing/screenshots for BOTH manually-created contexts.
    // Disable automatic chunks so Playwright does not start tracing twice.
    serviceWorkers: 'block', trace: 'off', screenshot: 'off',
    launchOptions: { executablePath: process.env.FATE_WEB_CHROMIUM_EXECUTABLE,
      args: ['--disable-background-networking', `--proxy-server=${process.env.FATE_WEB_DENY_PROXY}`,
        '--proxy-bypass-list=127.0.0.1;localhost'] } },
});
