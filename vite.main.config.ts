import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve('src/main/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: path.resolve('dist/main'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      // Chord carries native async-context identity shared by external Pi modules.
      // Do not duplicate it (or Durable's storage/context bindings) in the host bundle.
      external: (id) => id === '@earendil-works/pi-durable' || id.startsWith('@earendil-works/pi-durable/')
        || id === '@earendil-works/chord' || id.startsWith('@earendil-works/chord/')
        || id === 'electron' || id.startsWith('node:') || id === 'node-pty' || id === 'transcribe-cpp' || id === 'uiohook-napi' || id === '@earendil-works/pi-coding-agent' || id.startsWith('@modelcontextprotocol/sdk/'),
    },
  },
});
