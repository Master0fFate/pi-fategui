import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    lib: { entry: path.resolve('tests/e2e/main.ts'), formats: ['es'], fileName: () => 'index.js' },
    outDir: path.resolve('.test-dist/main'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { external: (id) => id === 'electron' || id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' },
  },
});
