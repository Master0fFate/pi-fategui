import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listPackage } from '@electron/asar';

const root = path.resolve(import.meta.dirname, '..');
const release = path.join(root, 'release');

function findExecutable() {
  const candidates = process.platform === 'win32'
    ? ['win-unpacked/fate-ui.exe', 'win-unpacked/Fate UI.exe']
    : process.platform === 'darwin'
      ? [
          'mac/Fate UI.app/Contents/MacOS/fate-ui',
          'mac/Fate UI.app/Contents/MacOS/Fate UI',
          'mac-arm64/Fate UI.app/Contents/MacOS/fate-ui',
          'mac-arm64/Fate UI.app/Contents/MacOS/Fate UI',
          'mac-x64/Fate UI.app/Contents/MacOS/fate-ui',
          'mac-x64/Fate UI.app/Contents/MacOS/Fate UI',
        ]
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
      } else if ((process.platform === 'win32' && (name === 'fate-ui.exe' || name === 'Fate UI.exe')) || (process.platform !== 'win32' && (name === 'Fate UI' || name === 'fate-ui' || name === 'pi-desktop'))) return candidate;
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
const expectedVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const installedVersionFile = path.join(resources, 'PRODVER');
if (!existsSync(installedVersionFile)) throw new Error(`Packaged PRODVER was not found at ${installedVersionFile}`);
const installedVersion = readFileSync(installedVersionFile, 'utf8');
if (installedVersion !== expectedVersion) throw new Error(`Packaged PRODVER ${JSON.stringify(installedVersion)} does not match ${expectedVersion}.`);
const unpackedPty = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');
if (!existsSync(unpackedPty)) throw new Error(`Packaged node-pty was not unpacked at ${unpackedPty}`);
const cliLauncher = process.platform === 'win32'
  ? path.join(path.dirname(executable), 'fate.cmd')
  : path.join(resources, 'cli', process.platform === 'darwin' ? 'fate' : 'fate-linux');
if (!existsSync(cliLauncher)) throw new Error(`Packaged fate launcher was not found at ${cliLauncher}`);
if (process.platform !== 'win32') accessSync(cliLauncher, constants.X_OK);
const asarPath = path.join(resources, 'app.asar');
const packagedFiles = listPackage(asarPath).map((entry) => entry.replaceAll('\\', '/'));
if (!packagedFiles.some((entry) => entry.endsWith('/node_modules/@earendil-works/pi-coding-agent/package.json'))) {
  throw new Error('The packaged application does not contain the embedded Pi coding-agent runtime.');
}

if (process.platform !== 'win32') accessSync(executable, constants.X_OK);

const timeoutMs = Number(process.env.PACKAGED_SMOKE_TIMEOUT_MS ?? '120000');
// The Intel macOS hosted DMG runner can SIGBUS while Electron creates its GPU
// context. Parakeet uses CPU there by design, so disable only this unrelated
// renderer path for the opt-in native stream check; normal package smoke keeps GPU enabled.
const applicationArguments = process.platform === 'darwin' && process.arch === 'x64' && process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1'
  ? ['--disable-gpu']
  : [];
const child = spawn(executable, applicationArguments, {
  cwd: root,
  env: { ...process.env, FATE_NEW_INSTANCE: '1', PI_DESKTOP_SMOKE: '1', PI_OFFLINE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const requiredMarkers = ['PI_DESKTOP_SPEECH_OK', 'PI_DESKTOP_YT_DLP_OK', 'PI_DESKTOP_THEMES_OK', 'PI_DESKTOP_TERMINAL_OK', 'PI_DESKTOP_SMOKE_OK'];
if (process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1') requiredMarkers.push('PI_DESKTOP_PARAKEET_STREAM_OK');
const seenMarkers = new Set();
let output = '';
let timedOut = false;
const capture = (chunk) => {
  const combined = `${output}${chunk.toString()}`;
  for (const marker of requiredMarkers) if (combined.includes(marker)) seenMarkers.add(marker);
  output = combined.slice(-1_000_000);
};
child.stdout.on('data', (chunk) => { capture(chunk); process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { capture(chunk); process.stderr.write(chunk); });
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGKILL');
}, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000);
const [exitCode, exitSignal] = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    resolve([code, signal]);
  });
});
clearTimeout(timeout);
if (timedOut) throw new Error(`Packaged smoke test timed out after ${timeoutMs} ms.`);
if (!seenMarkers.has('PI_DESKTOP_SPEECH_OK')) throw new Error(`Packaged speech runtime did not initialize (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
if (!seenMarkers.has('PI_DESKTOP_YT_DLP_OK')) throw new Error(`Packaged yt-dlp runtime did not initialize (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
if (!seenMarkers.has('PI_DESKTOP_THEMES_OK')) throw new Error(`Packaged Pi themes did not load (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
if (!seenMarkers.has('PI_DESKTOP_TERMINAL_OK')) throw new Error(`Packaged manual terminal PTY did not start and exit cleanly (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
if (!seenMarkers.has('PI_DESKTOP_SMOKE_OK')) throw new Error(`Packaged smoke marker was not observed (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
if (process.env.PI_DESKTOP_SPEECH_STREAM_SMOKE === '1' && !seenMarkers.has('PI_DESKTOP_PARAKEET_STREAM_OK')) {
  throw new Error(`Packaged Parakeet streaming smoke did not complete (exit ${exitCode}${exitSignal ? `, signal ${exitSignal}` : ''}).`);
}
if (exitCode !== 0 || exitSignal) throw new Error(`Packaged application exited unexpectedly (exit ${exitCode}, signal ${exitSignal ?? 'none'}).`);
console.log('PI_DESKTOP_PACKAGED_SMOKE_OK');
