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
      // Native Pi modules must share Chord context identity; node:sqlite is a host built-in.
      external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' || id === '@earendil-works/pi-ai'
        || id === '@earendil-works/pi-durable' || id.startsWith('@earendil-works/pi-durable/')
        || id === '@earendil-works/pi-client' || id.startsWith('@earendil-works/pi-client/')
        || id === '@earendil-works/pi-server' || id.startsWith('@earendil-works/pi-server/')
        || id === '@earendil-works/pi-protocol' || id.startsWith('@earendil-works/pi-protocol/')
        || id === '@earendil-works/chord' || id.startsWith('@earendil-works/chord/')
        || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws',
    },
  },
});
