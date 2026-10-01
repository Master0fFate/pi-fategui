import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({ build: { lib: { entry: path.resolve('src/cli/main.ts'), formats: ['es'], fileName: () => 'main.js' },
  outDir: 'dist/cli', emptyOutDir: true, target: 'node22', minify: false,
  rollupOptions: { output: { banner: (chunk) => chunk.isEntry ? '#!/usr/bin/env node' : '' }, external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' || id === '@earendil-works/pi-ai'
    || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws' } } });
