import { defineConfig } from 'vite';
import path from 'node:path';

/** Independent Node artifact. No Electron entry, native staging, or HTTP listener. */
export default defineConfig({
  build: {
    lib: { entry: path.resolve('src/server/main.ts'), formats: ['es'], fileName: () => 'main.js' },
    outDir: path.resolve('dist/server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' || id === '@earendil-works/pi-ai'
        || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws',
    },
  },
});
