import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
const guard = pathToFileURL(path.join(root, 'tests/network/loopbackGuard.mjs')).href;
const isolated = await createIsolatedEnvironment();
let observedCode;
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard, path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run', '--configLoader', 'runner', '--config', path.join(root, 'vitest.network.config.ts'), ...process.argv.slice(2)], {
      cwd: root, env: isolated.env, stdio: 'inherit', shell: false,
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  observedCode = code;
  process.exitCode = code;
} finally {
  try {
    const receipts = path.join(isolated.root, 'actual-cli-observations.jsonl');
    if ((await stat(receipts)).size > 1024 * 1024) throw new Error('CLI observation log exceeds the bound.');
    process.stdout.write(`\nActual CLI process receipts (synthetic private fixtures):\n${await readFile(receipts, 'utf8')}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await isolated.cleanup({ retain: observedCode !== 0 }); }
}
