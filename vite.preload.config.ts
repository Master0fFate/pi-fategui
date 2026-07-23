import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve('src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    outDir: path.resolve('dist/preload'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: ['electron'],
    },
  },
});
