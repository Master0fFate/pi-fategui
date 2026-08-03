import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [executableArgument, ...applicationArguments] = process.argv.slice(2);
if (!executableArgument) {
  throw new Error('Usage: node scripts/smoke-executable.mjs <executable> [arguments...]');
}

const executable = path.resolve(executableArgument);
accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);

const child = spawn(executable, applicationArguments, {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, PI_DESKTOP_SMOKE: '1', PI_OFFLINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);

for (const marker of ['PI_DESKTOP_SPEECH_OK', 'PI_DESKTOP_YT_DLP_OK', 'PI_DESKTOP_THEMES_OK', 'PI_DESKTOP_SMOKE_OK']) {
  if (!output.includes(marker)) {
    throw new Error(`Installed application did not emit ${marker} (exit ${String(result.code)}, signal ${String(result.signal)}).`);
  }
}
if (result.code !== 0) {
  throw new Error(`Installed application exited with code ${String(result.code)} (signal ${String(result.signal)}).`);
}
console.log('PI_DESKTOP_INSTALLED_SMOKE_OK');
