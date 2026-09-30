import { build } from 'vite';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolated } from './run-v2-tests.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(projectRoot, '.test-dist', 'headless-smoke');
try {
  await build({ configFile: path.join(projectRoot, 'vite.server.config.ts') });
  const production = await readFile(path.join(projectRoot, 'dist/server/main.js'), 'utf8');
  if (/FATE_FAKE_PROVIDER|--fake-provider|FakePiSdkAdapter|V2_PROVIDER_BLOCKED|headlessSmokeRunner/u.test(production)) {
    throw new Error('Production server artifact includes test-only fake activation.');
  }
  await build({ configFile: path.join(projectRoot, 'vite.smoke.config.ts') });
  process.exitCode = await runIsolated([path.join(output, 'runner.mjs')]);
} finally {
  await rm(output, { recursive: true, force: true, maxRetries: 3 });
}
