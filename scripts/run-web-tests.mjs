import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';

const root = path.resolve(import.meta.dirname, '..');
// Resolve the installed browser BEFORE replacing HOME. Never invoke playwright install.
const cache = path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright')));
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
if (!executable) throw new Error(`No installed Chromium in ${cache}. Parent must pass PLAYWRIGHT_BROWSERS_PATH; this runner never downloads a browser.`);

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
  const run = (args) => new Promise((resolve, reject) => {
    active = spawn(process.execPath, ['--import', guard, ...args], { cwd: root, env, stdio: 'inherit', shell: false });
    active.once('error', reject);
    active.once('exit', (code, signal) => { active = undefined; resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const built = await run([path.join(root, 'tests/web/build.mjs')]);
  process.exitCode = built === 0 ? await run([path.join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    '--config', path.join(root, 'playwright.web.config.ts'), ...process.argv.slice(2)]) : built;
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  await new Promise((resolve) => { denyProxy.closeAllConnections(); denyProxy.close(resolve); });
  await isolated.cleanup();
}
