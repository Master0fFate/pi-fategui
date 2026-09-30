import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const nodeTests = [
  'src/main/**/*.test.{ts,tsx}',
  'scripts/**/*.test.mjs',
  'src/renderer/stores/runtimeStore.test.ts',
  'src/renderer/features/shell/flightDeck.test.ts',
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve('src/renderer'),
      '@shared': path.resolve('src/shared'),
    },
  },
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: nodeTests,
          exclude: ['src/{core,server,client,protocol}/**', 'src/shared/protocol/**', 'src/main/connections/**', 'src/**/v2/**', 'tests/v2/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...nodeTests, 'src/{core,server,client,protocol}/**', 'src/shared/protocol/**', 'src/**/v2/**', 'tests/v2/**', 'src/renderer/features/connections/**'],
        },
      },
    ],
  },
});
