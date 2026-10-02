import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({ build: { lib: { entry: path.resolve('src/cli/main.ts'), formats: ['es'], fileName: () => 'main.js' },
  outDir: 'dist/cli', emptyOutDir: true, target: 'node22', minify: false,
  rollupOptions: { output: { banner: (chunk) => chunk.isEntry ? '#!/usr/bin/env node' : '' }, external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent' || id === '@earendil-works/pi-ai'
    || id === '@earendil-works/pi-durable' || id.startsWith('@earendil-works/pi-durable/')
    || id === '@earendil-works/chord' || id.startsWith('@earendil-works/chord/')
    || id === '@earendil-works/pi-client' || id.startsWith('@earendil-works/pi-client/')
    || id === '@earendil-works/pi-server' || id.startsWith('@earendil-works/pi-server/')
    || id === '@earendil-works/pi-protocol' || id.startsWith('@earendil-works/pi-protocol/')
    || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws' } } });
