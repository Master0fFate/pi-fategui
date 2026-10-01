import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Resolve the installed browser BEFORE replacing HOME. Never invoke playwright install.
export async function selectChromiumExecutable(inherited = process.env) {
  const cache = path.resolve(inherited.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32'
    ? path.join(inherited.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright')));
  const requested = inherited.FATE_WEB_CHROMIUM_EXECUTABLE;
  // Opt-in only: never search PATH or silently fall back when an override is invalid.
  // Selecting an external executable does not certify its Playwright/browser version.
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !requested.trim() || !path.isAbsolute(requested)) {
      throw new Error('FATE_WEB_CHROMIUM_EXECUTABLE must be a nonempty absolute executable path.');
    }
    let executable;
    try {
      executable = await realpath(requested);
      if (!(await stat(executable)).isFile()) throw new Error('Not a regular file.');
      await access(executable, constants.X_OK);
    } catch (error) {
      throw new Error(`FATE_WEB_CHROMIUM_EXECUTABLE must identify an existing regular executable file: ${requested}`, { cause: error });
    }
    return { cache, executable };
  }
  const entries = (await readdir(cache).catch(() => [])).filter((entry) => /^chromium(?:_headless_shell)?-\d+$/u.test(entry))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  let executable;
  for (const entry of entries) {
    const candidates = entry.startsWith('chromium_headless_shell-')
      ? process.platform === 'win32' ? ['chrome-headless-shell-win64/chrome-headless-shell.exe']
        : process.platform === 'darwin' ? ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-mac/chrome-headless-shell']
          : ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell']
      : process.platform === 'win32' ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
        : process.platform === 'darwin' ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
          : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
    for (const candidate of candidates) {
      try { await access(path.join(cache, entry, candidate)); executable = path.join(cache, entry, candidate); break; }
      catch { /* Try another already installed executable. */ }
    }
    if (executable) break;
  }
  if (!executable) throw new Error(`No installed Chromium in ${cache}. Parent must pass PLAYWRIGHT_BROWSERS_PATH or FATE_WEB_CHROMIUM_EXECUTABLE; this runner never downloads a browser.`);
  return { cache, executable };
}

async function runWebTests(args) {
  const { cache, executable } = await selectChromiumExecutable();
  const isolated = await createIsolatedEnvironment();
  // Chromium itself is not covered by Node's outbound guard. Any non-loopback
  // browser traffic hits this deny-only proxy, not the public network.
  const denyProxy = createServer((_request, response) => { response.writeHead(403); response.end('Fixture forbids outbound browser traffic.'); });
  denyProxy.on('connect', (_request, socket) => socket.destroy());
  let active;
  const interrupt = () => active?.kill('SIGINT');
  const terminate = () => active?.kill('SIGTERM');
  try {
    await new Promise((resolve, reject) => { denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve); });
    const address = denyProxy.address();
    if (!address || typeof address === 'string') throw new Error('Browser deny proxy failed to bind.');
    const env = { ...isolated.env, PLAYWRIGHT_BROWSERS_PATH: cache, FATE_WEB_CHROMIUM_EXECUTABLE: executable,
      FATE_WEB_DENY_PROXY: `http://127.0.0.1:${address.port}`, FATE_WEB_BUILD_ROOT: path.join(root, '.test-dist', 'web-acceptance'),
      FATE_WEB_PROJECT_ROOT: root };
    const guard = pathToFileURL(path.join(root, 'tests/network/loopbackGuard.mjs')).href;
    const run = (entryArgs) => new Promise((resolve, reject) => {
      active = spawn(process.execPath, ['--import', guard, ...entryArgs], { cwd: root, env, stdio: 'inherit', shell: false });
      active.once('error', reject);
      active.once('exit', (code, signal) => { active = undefined; resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
    });
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const built = await run([path.join(root, 'tests/web/build.mjs')]);
    return built === 0 ? await run([path.join(root, 'node_modules/@playwright/test/cli.js'), 'test',
      '--config', path.join(root, 'playwright.web.config.ts'), ...args]) : built;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    await new Promise((resolve) => { denyProxy.closeAllConnections(); denyProxy.close(resolve); });
    await isolated.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWebTests(process.argv.slice(2));
}
