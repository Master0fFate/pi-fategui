import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  plugins: [
    react(),
    {
      name: 'pi-desktop-csp',
      transformIndexHtml(html) {
        const scriptPolicy = command === 'serve' ? "'self' 'unsafe-inline'" : "'self'";
        return html.replace('__SCRIPT_CSP__', scriptPolicy);
      },
    },
  ],
  base: './',
  resolve: {
    alias: {
      '@renderer': path.resolve('src/renderer'),
      '@shared': path.resolve('src/shared'),
      'monaco-editor-esm': path.resolve('node_modules/monaco-editor/esm/vs'),
    },
  },
  build: {
    outDir: path.resolve('dist/renderer'),
    emptyOutDir: true,
    // Keep bundled fonts as local files so the strict font-src CSP never blocks
    // Vite-inlined data URLs and the stylesheet stays cheaper to parse.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));
