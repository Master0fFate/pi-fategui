import path from 'node:path';
import { build } from 'vite';

const root = process.env.FATE_WEB_PROJECT_ROOT;
const output = process.env.FATE_WEB_BUILD_ROOT;
if (!root || !output || !process.env.FATE_V2_TEST_ROOT) throw new Error('Use node scripts/run-web-tests.mjs.');
// This is the genuine production browser entry/config, not a test-only React App.
await build({ configFile: path.join(root, 'vite.web.config.ts'), logLevel: 'warn' });
await build({ configFile: false, root,
  build: { lib: { entry: path.join(root, 'tests/web/server.ts'), formats: ['es'], fileName: () => 'server.mjs' },
    outDir: output, emptyOutDir: true, target: 'node22', minify: false,
    rollupOptions: { external: (id) => id.startsWith('node:') || id === '@earendil-works/pi-coding-agent'
      || id.startsWith('@modelcontextprotocol/sdk/') || id === 'node-pty' || id === 'ws' } }, logLevel: 'warn' });
