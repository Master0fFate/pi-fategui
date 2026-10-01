import { defineConfig } from 'vite';
import path from 'node:path';

/** TEST ONLY: deliberately outside dist/server and every production package. */
export default defineConfig({
  build: {
    lib: { entry: path.resolve('tests/remote/host.ts'), formats: ['es'], fileName: () => 'host.mjs' },
    outDir: path.resolve('tests/remote/.built'), emptyOutDir: true, target: 'node22', minify: false,
    rollupOptions: { external: id => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' || id === '@earendil-works/pi-ai'
      || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws' },
  },
});
