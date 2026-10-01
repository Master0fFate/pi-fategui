import { defineConfig } from 'vitest/config';
import path from 'node:path';

if (!process.env.FATE_V2_TEST_ROOT) throw new Error('Run v2 tests through scripts/run-v2-tests.mjs');

export default defineConfig({
  cacheDir: path.join(process.env.FATE_V2_TEST_ROOT, 'vite-cache'),
  plugins: [{
    name: 'v2-no-electron',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'electron' || id.startsWith('electron/')) throw new Error('V2_ELECTRON_BLOCKED');
    },
  }],
  resolve: { alias: { '@shared': path.resolve('src/shared'), '@renderer': path.resolve('src/renderer') } },
  test: {
    restoreMocks: true,
    // Windows ACL checks are real host-policy probes, not mocked mode bits.
    testTimeout: process.platform === 'win32' ? 90_000 : 30_000,
    pool: 'forks',
    // Native ACL subprocesses plus real Git/Node contenders oversubscribe a
    // Windows workstation at the CPU-derived default. Bound independent test
    // workers, not lock deadlines: the 15s ownership case remains unchanged.
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}),
    projects: [
      {
        extends: true,
        test: {
          name: 'v2-node',
          environment: 'node',
          include: [
            'tests/v2/**/*.test.{ts,tsx}',
            'src/{core,server,client,protocol}/**/*.test.{ts,tsx}',
            'src/shared/protocol/**/*.test.{ts,tsx}',
            'src/main/connections/**/*.test.{ts,tsx}',
            'src/**/v2/**/*.test.{ts,tsx}',
          ],
          exclude: ['tests/v2/connectionUi.test.tsx'],
          setupFiles: ['./tests/v2/helpers/nodeGuard.mjs'],
        },
      },
      {
        extends: true,
        test: {
          name: 'v2-connection-ui',
          environment: 'jsdom',
          include: ['tests/v2/connectionUi.test.tsx', 'src/renderer/features/connections/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
