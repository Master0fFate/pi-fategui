import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, target) => target === root || target.startsWith(root + path.sep);
async function nodeExecutable() {
  if (path.isAbsolute(process.execPath)) return process.execPath;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
    const candidate = path.join(directory, process.execPath);
    try { await fs.access(candidate); if ((await fs.stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('A supported absolute Node executable was not found.');
}

export async function verifyPackage(root) {
  const checksums = (await fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  const observedFiles = new Set(); const observedLinks = new Set();
  const inspectTree = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) observedLinks.add(relative);
      else if (entry.isDirectory()) await inspectTree(path.join(directory, entry.name), relative);
      else { assert(entry.isFile(), 'Special file in package.'); if (relative !== 'SHA256SUMS') observedFiles.add(relative); }
    }
  };
  await inspectTree(root); const recordedFiles = new Set();
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line); assert(match, 'Invalid checksum line.');
    assert(!recordedFiles.has(match[2]), 'Duplicate checksum path.'); recordedFiles.add(match[2]);
    const file = path.resolve(root, match[2]); assert(within(root, file), 'Checksum path escapes artifact.');
    const stat = await fs.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink(), 'Checksum target is not a regular file.');
    assert.equal(hash(await fs.readFile(file)), match[1], `Artifact checksum mismatch: ${match[2]}`);
  }
  assert.deepEqual([...recordedFiles].sort(), [...observedFiles].sort(), 'Checksum file set does not match the package.');
  const links = JSON.parse(await fs.readFile(path.join(root, 'LINKS.json'), 'utf8'));
  assert.deepEqual(links.map(link => link.path).sort(), [...observedLinks].sort(), 'Link file set does not match the package.');
  for (const link of links) {
    const file = path.resolve(root, link.path); assert(within(root, file), 'Link path escapes artifact.');
    assert.equal(await fs.readlink(file), link.target, 'Artifact link changed.');
    assert(within(root, await fs.realpath(file)), 'Artifact link resolves outside independent package.');
  }
  const require = createRequire(path.join(root, 'package.json'));
  for (const name of ['electron', 'electron-builder', 'transcribe-cpp', 'uiohook-napi']) {
    assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' }, `Desktop package is available: ${name}`);
  }
  return { checksumFiles: checksums.length, internalLinks: links.length, electronResolutionAvailable: false };
}

export async function probeNative(root) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.electron, undefined);
  const ptyRoot = await fs.realpath(path.join(root, 'node_modules/node-pty'));
  assert(within(root, ptyRoot), 'Native package must belong to this independent artifact.');
  const candidates = ['build/Release/pty.node', 'build/Debug/pty.node', 'prebuilds/linux-x64/pty.node'];
  let binary;
  for (const relative of candidates) {
    try { await fs.access(path.join(ptyRoot, relative)); binary = path.join(ptyRoot, relative); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert(binary, 'Linux x64 Node-native PTY is unavailable.');
  const bytes = await fs.readFile(binary);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(bytes[4], 2); assert.equal(bytes[5], 1); assert.equal(bytes.readUInt16LE(18), 62);
  const { spawn: spawnPty } = createRequire(path.join(root, 'package.json'))('node-pty');
  const marker = 'FATE_NODE_NATIVE_PTY_OK';
  const child = spawnPty('/bin/sh', ['-c', `printf '${marker}'; exit 0`], {
    cwd: root, cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm' },
  });
  let output = '';
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { try { child.kill(); } catch { /* Own child only. */ } reject(new Error('Node PTY did not settle within 5000 ms.')); }, 5000);
    child.onData(value => { output += value; if (output.length > 4096) {
      clearTimeout(timeout); try { child.kill(); } catch { /* Own child only. */ } reject(new Error('Oversized Node PTY fixture output.'));
    } });
    child.onExit(exit => { clearTimeout(timeout); resolve(exit); });
  });
  assert.equal(result.exitCode, 0); assert(output.includes(marker));
  return { node: process.version, abi: process.versions.modules, electron: null, binary: path.relative(root, binary),
    sha256: hash(bytes), childPid: child.pid, exitCode: result.exitCode, bytes: Buffer.byteLength(output), markerObserved: true };
}

async function port() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address(); assert(address && typeof address !== 'string');
  const result = address.port; await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return result;
}

function launch(node, entry, args, cwd, env, guard) {
  const child = spawn(node, [...(guard ? ['--import', guard] : []), entry, ...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const lines = []; const listeners = new Set();
  child.stdout.on('data', data => {
    stdout += data; assert(stdout.length < 1_048_576, 'Oversized package smoke output.');
    let index; while ((index = stdout.indexOf('\n', lines.reduce((count, value) => count + value.length + 1, 0))) >= 0) {
      const consumed = lines.reduce((count, value) => count + value.length + 1, 0);
      lines.push(stdout.slice(consumed, index)); for (const callback of listeners) callback();
    }
  });
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const safeOutput = () => {
    assert(!/(?:fo1|fc1|fb1|fs1|ft1)_[A-Za-z0-9_-]{43}/u.test(stdout + stderr), 'Server command exposed a private credential.');
    return { stdout, stderr };
  };
  return { child, exited, safeOutput, lines, listeners };
}

async function bounded(promise, label, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function ready(processHandle) {
  return bounded(new Promise((resolve, reject) => {
    const inspect = () => {
      for (const line of processHandle.lines) {
        try { const value = JSON.parse(line); const state = value.readiness ?? value;
          if (state.ready === true && Number.isSafeInteger(state.port)) { processHandle.listeners.delete(inspect); resolve(state); return; }
        } catch { /* Only a complete structured readiness record counts. */ }
      }
    };
    processHandle.listeners.add(inspect); inspect();
    processHandle.exited.then(exit => { processHandle.listeners.delete(inspect); reject(new Error(`Production CLI stopped before readiness: ${JSON.stringify(exit)} ${processHandle.safeOutput().stderr}`)); }, reject);
  }), 'Production CLI did not emit structured readiness within 15000 ms.');
}

export async function smokePackage(packageRoot, { terminal = false } = {}) {
  assert.equal(process.platform, 'linux', 'This package smoke proves Linux only.');
  const original = await fs.realpath(packageRoot);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'fate-package-smoke-'));
  const relocated = path.join(temporary, 'independent package with spaces');
  const home = path.join(temporary, 'private home with spaces');
  const workspace = path.join(temporary, 'workspace with spaces');
  const guard = path.join(temporary, 'package-only-guard.mjs');
  const processes = [];
  let complete = false;
  try {
    await fs.cp(original, relocated, { recursive: true, verbatimSymlinks: true });
    await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(workspace, { mode: 0o700 });
    await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'production-package-smoke-sentinel\n');
    const node = await nodeExecutable();
    const env = { HOME: home, USERPROFILE: home, PATH: `${path.dirname(node)}:/usr/bin:/bin`, LANG: 'C.UTF-8', PI_OFFLINE: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temporary, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0',
      FATE_PACKAGE_ROOT: relocated, NODE_ENV: 'production', TMPDIR: temporary, TZ: 'UTC' };
    await fs.writeFile(guard, `import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url'; import path from 'node:path';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
const deny=()=>{throw new Error('PACKAGE_SMOKE_OUTBOUND_FORBIDDEN')};
http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;tls.connect=deny;globalThis.fetch=async()=>deny();syncBuiltinESMExports();
const root=process.env.FATE_PACKAGE_ROOT;
registerHooks({resolve(specifier,context,next){
if (/^(electron(?:-builder|-updater)?|transcribe-cpp|uiohook-napi)(?:\\/|$)/u.test(specifier)) throw new Error('PACKAGE_DESKTOP_IMPORT_FORBIDDEN');
const result=next(specifier,context);if(result.url.startsWith('file:')){const file=fileURLToPath(result.url);if(file!==root&&!file.startsWith(root+path.sep))throw new Error('PACKAGE_CHECKOUT_IMPORT_FORBIDDEN');}return result;}});
`);
    const checks = await verifyPackage(relocated);
    const entry = path.join(relocated, 'dist/cli/main.js');
    const selectedPort = await port();
    const runCli = async args => {
      const handle = launch(node, entry, args, relocated, env, guard); processes.push(handle);
      const exit = await bounded(handle.exited, 'A production CLI smoke command did not settle.');
      return { ...exit, ...handle.safeOutput() };
    };
    const installedBin = path.join(temporary, 'installed bin with spaces');
    await fs.mkdir(installedBin, { mode: 0o700 });
    const linkedCompanion = path.join(installedBin, 'fate-server');
    await fs.symlink(path.join(relocated, 'bin/fate-server'), linkedCompanion);
    const companion = launch('/bin/sh', linkedCompanion, ['help'], temporary, env); processes.push(companion);
    assert.equal((await bounded(companion.exited, 'Symlinked companion did not settle.')).code, 0);
    assert(companion.safeOutput().stdout.includes('fate-server init'));
    const missingNode = launch('/bin/sh', linkedCompanion, ['help'], temporary, { ...env, PATH: installedBin }); processes.push(missingNode);
    assert.equal((await bounded(missingNode.exited, 'Missing Node check did not settle.')).code, 1);
    assert(missingNode.safeOutput().stderr.includes('Install Node 22.19'));
    const invalid = await runCli(['--unknown']); assert.equal(invalid.code, 1);
    assert(invalid.stderr.includes('Use fate-server help'));
    const initialize = await runCli(['init', '--profile', 'smoke', '--workspace', workspace, '--trust-workspace', '--port', String(selectedPort)]);
    assert.equal(initialize.code, 0, initialize.stderr);
    const before = await runCli(['doctor', '--profile', 'smoke']); assert.equal(before.code, 0, before.stderr);
    const preflight = JSON.parse(before.stdout.trim()); assert.equal(preflight.provider, 'auth-required');
    const host = launch(node, entry, ['serve', '--profile', 'smoke'], relocated, env, guard); processes.push(host);
    const readiness = await ready(host); assert.equal(readiness.port, selectedPort); assert.equal(readiness.host, '127.0.0.1');
    assert(/^[a-f0-9-]{36}$/u.test(readiness.hostId));
    assert.equal(readiness.workspaces.length, 1); assert(/^[a-f0-9-]{36}$/u.test(readiness.workspaces[0].workspaceId));
    assert(Number.isSafeInteger(readiness.workspaces[0].workspaceGeneration));
    const unauthorized = await fetch(`http://127.0.0.1:${selectedPort}/api/info`, { signal: AbortSignal.timeout(5000) });
    assert.equal(unauthorized.status, 401, 'Production service must require authentication.');
    const conflict = await runCli(['serve', '--profile', 'smoke']); assert.notEqual(conflict.code, 0, 'Two profile writers were admitted.');
    // A distinct port prevents EADDRINUSE from being mistaken for profile ownership refusal.
    const competingPort = await port(); assert.notEqual(competingPort, selectedPort);
    const competingConfig = { profile: { profileId: 'smoke', home }, workspaces: [workspace], host: '127.0.0.1',
      port: competingPort, flags: { terminal: false, browser: false }, maxPermission: 'read-only' };
    const contentionCode = `import {startAuthenticatedNodeServer} from ${JSON.stringify(pathToFileURL(path.join(relocated, 'dist/server/main.js')).href)};
let refused=false;try{const server=await startAuthenticatedNodeServer(${JSON.stringify(competingConfig)});await server.stop();}
catch(error){if(error instanceof Error&&error.message.startsWith('Owner already in use'))refused=true;else throw error;}
if(!refused)throw new Error('A second profile writer was admitted on a different port.');console.log(JSON.stringify({ownershipRefusal:true}));`;
    const distinct = launch(node, '--input-type=module', ['-e', contentionCode], relocated, env, guard); processes.push(distinct);
    const distinctExit = await bounded(distinct.exited, 'Different-port profile contention did not settle.');
    const distinctOutput = distinct.safeOutput(); assert.equal(distinctExit.code, 0, distinctOutput.stderr);
    assert.equal(JSON.parse(distinctOutput.stdout.trim()).ownershipRefusal, true);
    const current = await runCli(['doctor', '--profile', 'smoke']); assert.equal(current.code, 0);
    const owned = JSON.parse(current.stdout.trim()); assert.equal(owned.ownership, 'owner-record-present');
    const clientCode = `import http from 'node:http';
const request=http.get(${JSON.stringify(`http://127.0.0.1:${selectedPort}/healthz`)},{agent:false,headers:{Connection:'close'}},response=>{
let bytes='';response.on('data',part=>bytes+=part);response.on('end',()=>{
if(response.statusCode!==200||JSON.parse(bytes).ready!==true)process.exitCode=1;
console.log(JSON.stringify({healthStatus:response.statusCode}));request.destroy();});});
request.setTimeout(5000,()=>request.destroy(new Error('Health fixture timeout')));
request.once('error',()=>{process.stderr.write('Health client failed.');process.exitCode=1;});`;
    // This fixed loopback-only client is a separate process. It has no provider or host credential.
    const client = launch(node, '--input-type=module', ['-e', clientCode], relocated, env, null); processes.push(client);
    const clientExit = await bounded(client.exited, 'Short-lived real HTTP client did not settle.');
    const clientOutput = client.safeOutput(); assert.equal(clientExit.code, 0, clientOutput.stderr);
    assert.equal(JSON.parse(clientOutput.stdout.trim()).healthStatus, 200);
    assert.equal(host.child.exitCode, null); assert.equal(host.child.signalCode, null); process.kill(host.child.pid, 0);
    const healthAfterClientExit = await fetch(`http://127.0.0.1:${selectedPort}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert.equal(healthAfterClientExit.status, 200); assert.equal((await healthAfterClientExit.json()).ready, true);
    host.child.kill('SIGTERM'); const stopped = await bounded(host.exited, 'Production SIGTERM did not settle.');
    host.safeOutput(); assert.equal(stopped.code, 0); assert.equal(stopped.signal, null);
    const after = await runCli(['doctor', '--profile', 'smoke']); assert.equal(after.code, 0);
    const released = JSON.parse(after.stdout.trim()); assert.equal(released.ownership, 'no-owner-record');
    const restarted = launch(node, entry, ['serve', '--profile', 'smoke'], relocated, env, guard); processes.push(restarted);
    await ready(restarted); restarted.child.kill('SIGTERM');
    const restartedExit = await bounded(restarted.exited, 'Restarted production SIGTERM did not settle.');
    restarted.safeOutput(); assert.equal(restartedExit.code, 0);
    assert.equal(await fs.readFile(path.join(workspace, 'sentinel.txt'), 'utf8'), 'production-package-smoke-sentinel\n');
    const native = terminal ? await probeNative(relocated) : null;
    complete = true;
    return { node: process.version, platform: process.platform, arch: process.arch, ...checks,
      independentRelocation: true, pathsWithSpaces: true, providerBeforeStartup: preflight.provider,
      companionPathSymlink: true, missingNodeSetupError: true, invalidModeHelp: true, publicWorkspacePins: true,
      authenticationStatus: unauthorized.status, profileConflictExit: conflict.code, profileLockReleased: true,
      differentPortOwnershipRefusal: true,
      gracefulStopExit: stopped.code, restartStopExit: restartedExit.code, workspaceSentinelUnchanged: true,
      ownHostPid: host.child.pid, clientPid: client.child.pid, clientExit: clientExit.code,
      hostAliveAfterClientExit: true, healthAfterClientExit: healthAfterClientExit.status,
      native, paidProviderCallsAllowed: false };
  } finally {
    for (const handle of processes) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill('SIGTERM');
        try { await bounded(handle.exited, 'Smoke cleanup did not settle.', 5000); }
        catch { handle.child.kill('SIGKILL'); await bounded(handle.exited, 'Smoke own-child force cleanup failed.', 5000); }
      }
    }
    if (complete) await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
    else console.error(`Failed production smoke fixture retained at ${temporary}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'server-manifest.json'), 'utf8'));
    if (process.argv[3] === '--verify-only') console.log(JSON.stringify(await verifyPackage(root)));
    else if (process.argv[3] === '--native-only') console.log(JSON.stringify(await probeNative(root)));
    else { assert(process.argv.length <= 3, 'Unknown smoke option.'); console.log(JSON.stringify(await smokePackage(root, { terminal: manifest.nativeTerminal }))); }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Server package smoke failed.'); process.exitCode = 1; }
}
