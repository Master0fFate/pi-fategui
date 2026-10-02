import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bundleMonacoFallbackWorker, verifyEmittedRendererModules } from './scripts/renderer-build-plugins';

const outDir = path.resolve('dist/web');

/** Separate browser artifact. It neither starts a Vite server nor touches dist/renderer. */
export default defineConfig({
  plugins: [bundleMonacoFallbackWorker(), react(), {
    name: 'fate-web-index',
    apply: 'build',
    async closeBundle() {
      // The dedicated source entry is web.html; the HTTP server serves / as index.html.
      await fs.rename(path.join(outDir, 'web.html'), path.join(outDir, 'index.html'));
    },
  }, verifyEmittedRendererModules()],
  base: '/',
  resolve: {
    alias: {
      '@renderer': path.resolve('src/renderer'),
      '@shared': path.resolve('src/shared'),
      'monaco-editor-esm': path.resolve('node_modules/monaco-editor/esm/vs'),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: path.resolve('web.html') },
  },
});
