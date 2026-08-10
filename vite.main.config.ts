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
      external: (id) => id === 'electron' || id.startsWith('node:') || id === 'node-pty' || id === 'transcribe-cpp' || id === 'uiohook-napi' || id === '@earendil-works/pi-coding-agent',
    },
  },
});
