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
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: ['electron', 'node:path', 'node:url'],
    },
  },
});
