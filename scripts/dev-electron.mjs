import { spawn } from 'node:child_process';
import { mkdirSync, watch } from 'node:fs';
import path from 'node:path';
import electronPath from 'electron';
import { resolveDevelopmentProfile } from './dev-profile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const developmentProfile = resolveDevelopmentProfile(root);
mkdirSync(developmentProfile.profileRoot, { recursive: true });
const watchedOutputs = new Map([
  [path.join(root, 'dist', 'main'), 'index.js'],
  [path.join(root, 'dist', 'preload'), 'index.cjs'],
]);
const developmentUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const restartDelayMs = 350;

let electronProcess;
let restartTimer;
let stopping = false;
let restarting = false;
let restartChain = Promise.resolve();

function electronArguments() {
  // Electron scopes its single-instance lock to userData. A dedicated profile
  // lets the development build run beside an installed Fate UI instance.
  const args = ['.', `--user-data-dir=${developmentProfile.electronUserData}`];
  const debuggingPort = process.env.PI_DESKTOP_REMOTE_DEBUGGING_PORT;
  if (debuggingPort && /^\d{2,5}$/.test(debuggingPort)) args.push(`--remote-debugging-port=${debuggingPort}`);
  return args;
}

function startElectron() {
  if (stopping) return;
  electronProcess = spawn(electronPath, electronArguments(), {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: developmentUrl,
      FATE_GUI_DATA_DIR: developmentProfile.fateGuiData,
    },
    stdio: 'inherit',
    windowsHide: false,
  });
  console.log(`[dev-electron] started isolated Electron (pid ${electronProcess.pid ?? 'unknown'})`);
  console.log(`[dev-electron] development profile: ${developmentProfile.profileRoot}`);
  electronProcess.once('error', (error) => {
    console.error(`[dev-electron] Electron failed to start: ${error.message}`);
  });
  electronProcess.once('exit', (code, signal) => {
    if (electronProcess?.exitCode !== null) electronProcess = undefined;
    if (stopping || restarting) return;
    if (code && code !== 0) console.error(`[dev-electron] Electron exited with code ${code}${signal ? ` (${signal})` : ''}.`);
    else console.log('[dev-electron] Electron closed; stopping the development stack.');
    void shutdown().finally(() => process.exit(code ?? 0));
  });
}

async function stopElectron() {
  const child = electronProcess;
  electronProcess = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill();
  });
}

function scheduleRestart(changedFile) {
  if (stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    restartChain = restartChain.then(async () => {
      console.log(`[dev-electron] ${changedFile} rebuilt; restarting Electron.`);
      restarting = true;
      await stopElectron();
      startElectron();
      restarting = false;
    });
  }, restartDelayMs);
}

const watchers = [...watchedOutputs].map(([directory, expectedFile]) => watch(directory, (_event, filename) => {
  if (filename?.toString() === expectedFile) scheduleRestart(expectedFile);
}));

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  await stopElectron();
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGHUP', () => { void shutdown().finally(() => process.exit(0)); });

startElectron();
