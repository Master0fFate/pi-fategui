import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listPackage } from '@electron/asar';

const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');

function findExecutable() {
  const candidates = process.platform === 'win32'
    ? ['win-unpacked/Fate UI.exe']
    : process.platform === 'darwin'
      ? ['mac/Fate UI.app/Contents/MacOS/Fate UI', 'mac-arm64/Fate UI.app/Contents/MacOS/Fate UI']
      : ['linux-unpacked/fate-ui', 'linux-unpacked/pi-desktop'];
  for (const candidate of candidates) {
    const executable = path.join(release, candidate);
    if (existsSync(executable)) return executable;
  }
  const visit = (directory) => {
    if (!existsSync(directory)) return null;
    for (const name of readdirSync(directory)) {
      const candidate = path.join(directory, name);
      if (statSync(candidate).isDirectory()) {
        const nested = visit(candidate);
        if (nested) return nested;
      } else if ((process.platform === 'win32' && name === 'Fate UI.exe') || (process.platform !== 'win32' && (name === 'Fate UI' || name === 'fate-ui' || name === 'pi-desktop'))) return candidate;
    }
    return null;
  };
  return visit(release);
}

const executable = findExecutable();
if (!executable) throw new Error(`No packaged Pi Desktop executable found under ${release}`);
const resources = process.platform === 'darwin'
  ? path.resolve(executable, '../../Resources')
  : path.join(path.dirname(executable), 'resources');
const unpackedPty = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
if (!existsSync(unpackedPty)) throw new Error(`Packaged node-pty was not unpacked at ${unpackedPty}`);
const asarPath = path.join(resources, 'app.asar');
const packagedFiles = listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/'));
if (!packagedFiles.some((entry) => entry.endsWith('/node_modules/@earendil-works/pi-coding-agent/package.json'))) {
  throw new Error('The packaged application does not contain the embedded Pi coding-agent runtime.');
}

const child = spawn(executable, [], {
  cwd: root,
  env: { ...process.env, PI_DESKTOP_SMOKE: '1', PI_OFFLINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });
const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timeout);
if (!output.includes('PI_DESKTOP_SPEECH_OK')) throw new Error(`Packaged speech runtime did not initialize (exit ${exitCode}).`);
if (!output.includes('PI_DESKTOP_YT_DLP_OK')) throw new Error(`Packaged yt-dlp runtime did not initialize (exit ${exitCode}).`);
if (!output.includes('PI_DESKTOP_SMOKE_OK')) throw new Error(`Packaged smoke marker was not observed (exit ${exitCode}).`);
if (exitCode !== 0) throw new Error(`Packaged application exited with code ${exitCode}.`);
console.log('PI_DESKTOP_PACKAGED_SMOKE_OK');
