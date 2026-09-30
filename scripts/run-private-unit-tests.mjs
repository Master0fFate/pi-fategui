import { spawn } from 'node:child_process';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

const isolated = await createIsolatedEnvironment();
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'pnpm test'], { cwd: process.cwd(), env: isolated.env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally { await isolated.cleanup(); }
