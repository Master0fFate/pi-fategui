import { defineConfig } from 'vitest/config';
import path from 'node:path';

if (!process.env.FATE_V2_TEST_ROOT) throw new Error('Run network tests through scripts/run-network-tests.mjs');
export default defineConfig({
  cacheDir: path.join(process.env.FATE_V2_TEST_ROOT, 'vite-cache'),
  plugins: [{ name: 'network-no-electron', enforce: 'pre', resolveId(id) {
    if (id === 'electron' || id.startsWith('electron/')) throw new Error('NETWORK_TEST_ELECTRON_BLOCKED');
  } }],
  test: { name: 'loopback-network', environment: 'node', include: ['tests/network/**/*.test.ts'],
    // Vitest fork workers do not retain the launcher's --import guard.
    // Install it inside each worker before any fixture can open a socket.
    setupFiles: ['./tests/network/loopbackGuard.mjs'],
    restoreMocks: true, testTimeout: process.platform === 'win32' ? 45_000 : 30_000, pool: 'forks', maxWorkers: 1 },
});
