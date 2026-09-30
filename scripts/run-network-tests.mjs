import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const guard = pathToFileURL(path.join(root, 'tests/network/loopbackGuard.mjs')).href;
const isolated = await createIsolatedEnvironment();
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard, path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run', '--configLoader', 'runner', '--config', path.join(root, 'vitest.network.config.ts'), ...process.argv.slice(2)], {
      cwd: root, env: isolated.env, stdio: 'inherit', shell: false,
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
} finally { await isolated.cleanup(); }
