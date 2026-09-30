import { defineConfig } from 'vite';
import path from 'node:path';

/** Test-only composition, never part of dist/server or the desktop package. */
export default defineConfig({
  build: {
    lib: { entry: path.resolve('tests/v2/helpers/headlessSmokeRunner.ts'), formats: ['es'], fileName: () => 'runner.mjs' },
    outDir: path.resolve('.test-dist/headless-smoke'), emptyOutDir: true,
    target: 'node22', minify: false,
    rollupOptions: { external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent'
      || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' },
  },
});
