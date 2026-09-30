import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
  : path.join(os.homedir(), '.cache', 'ms-playwright'));
const shells = (await readdir(cache).catch(() => []))
  .filter((entry) => /^chromium_headless_shell-\d+$/u.test(entry)).sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
const executable = await (async () => {
  for (const name of shells) {
    const file = path.join(cache, name, process.platform === 'win32' ? 'chrome-headless-shell-win64/chrome-headless-shell.exe'
      : process.platform === 'darwin' ? 'chrome-headless-shell-mac/chrome-headless-shell' : 'chrome-headless-shell-linux/chrome-headless-shell');
    try { await access(file); return file; } catch { /* Try an older installed Chromium shell. */ }
  }
  throw new Error('No installed Playwright Chromium headless shell. Install Chromium before the browser smoke; no browser download runs in this private test.');
})();
const isolated = await createIsolatedEnvironment();
try {
  const guard = pathToFileURL(path.join(root, 'tests/network/loopbackGuard.mjs')).href;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard, path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      '--configLoader', 'runner', '--config', path.join(root, 'vitest.network.config.ts'), 'tests/network/browserBundleSmoke.test.ts'], {
      cwd: root, env: { ...isolated.env, FATE_BROWSER_CHROMIUM_EXECUTABLE: executable }, stdio: 'inherit', shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally { await isolated.cleanup(); }
