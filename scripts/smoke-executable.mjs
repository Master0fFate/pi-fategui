import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [executableArgument, ...applicationArguments] = process.argv.slice(2);
if (!executableArgument) {
  throw new Error('Usage: node scripts/smoke-executable.mjs <executable> [arguments...]');
}

const executable = path.resolve(executableArgument);
accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
// See smoke-packaged.mjs: this affects only the opt-in Parakeet test on the
// flaky Intel macOS hosted DMG renderer, not normal packaged-app checks.
const smokeArguments = process.platform === 'darwin' && process.arch === 'x64' && process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1'
  ? ['--disable-gpu', ...applicationArguments]
  : applicationArguments;

const child = spawn(executable, smokeArguments, {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, FATE_NEW_INSTANCE: '1', PI_DESKTOP_SMOKE: '1', PI_OFFLINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const requiredMarkers = ['PI_DESKTOP_SPEECH_OK', 'PI_DESKTOP_YT_DLP_OK', 'PI_DESKTOP_THEMES_OK', 'PI_DESKTOP_TERMINAL_OK', 'PI_DESKTOP_SMOKE_OK'];
if (process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1') requiredMarkers.push('PI_DESKTOP_PARAKEET_STREAM_OK');
const seenMarkers = new Set();
let output = '';
const capture = (chunk) => {
  const combined = `${output}${chunk.toString()}`;
  for (const marker of requiredMarkers) if (combined.includes(marker)) seenMarkers.add(marker);
  output = combined.slice(-1_000_000);
};
child.stdout.on('data', (chunk) => {
  capture(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  capture(chunk);
  process.stderr.write(chunk);
});

const timeoutMs = Number(process.env.INSTALLED_SMOKE_TIMEOUT_MS ?? '45000');
const timeout = setTimeout(() => child.kill('SIGKILL'), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45_000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);

for (const marker of requiredMarkers) {
  if (!seenMarkers.has(marker)) {
    throw new Error(`Installed application did not emit ${marker} (exit ${String(result.code)}, signal ${String(result.signal)}).`);
  }
}
if (result.code !== 0) {
  throw new Error(`Installed application exited with code ${String(result.code)} (signal ${String(result.signal)}).`);
}
console.log('PI_DESKTOP_INSTALLED_SMOKE_OK');
