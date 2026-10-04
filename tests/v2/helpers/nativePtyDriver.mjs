// TEST ONLY. Trusted native-I/O driver: no Fate, Pi, provider or application imports.
// The parent Fate host retains its unchanged network guard. This process needs
// real ConPTY named-pipe I/O and is launched with execArgv: [] and a clean env.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAME_BYTES = 128 * 1024, IPC_BYTES = 512 * 1024, OUTPUT_CHUNK = 16_384;
const OUTPUT_BUFFER = 1024 * 1024, OUTPUT_WINDOW = 4;
const inside = (root, child) => {
  const relative = path.relative(root, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const dimensions = value => integer(value.cols, 2, 400) && integer(value.rows, 1, 200);
const ownFile = process.env.FATE_NATIVE_PTY_RECORD;
if (!process.send || !ownFile || !path.isAbsolute(ownFile) || process.execArgv.length !== 0) {
  throw new Error('Private native PTY driver startup required.');
}
let owner, terminal, nativeExit, failure = null, started = false, closing = false, completed = false;
let requestedPause = false, nativePaused = false, buffered = '', nextSequence = 1, outstanding = 0;
let sendingBytes = 0, sendingFrames = 0, consumptionTimer, stopTimer;
const pending = new Map(), subscriptions = [];
function publish() {
  const temporary = `${ownFile}.driver.tmp`;
  writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, ownFile);
}
function send(frame, callback) {
  if (!process.connected) throw new Error('Native driver owner disconnected.');
  const text = JSON.stringify(frame);
  const bytes = Buffer.byteLength(JSON.stringify(text)) + 1; // Include Node's outer JSON-string encoding/delimiter.
  if (bytes > FRAME_BYTES || sendingBytes + bytes > IPC_BYTES || sendingFrames >= 32) throw new Error('Native driver IPC limit.');
  sendingBytes += bytes; sendingFrames++;
  process.send(text, error => {
    sendingBytes -= bytes; sendingFrames--;
    if (error) {
      if (completed) process.exit(1);
      else fail('ipc-failure');
    } else callback?.();
  });
}
function armConsumption() {
  if (consumptionTimer || !pending.size || closing) return;
  consumptionTimer = setTimeout(() => fail('consumption-timeout'), 5_000);
}
function flow() {
  if (!terminal || nativeExit || closing) return;
  const pause = requestedPause || pending.size >= OUTPUT_WINDOW || buffered.length + outstanding >= 128 * 1024;
  if (pause === nativePaused) return;
  nativePaused = pause;
  if (pause) terminal.pause(); else terminal.resume();
}
function flush() {
  if (closing || completed) return;
  while (!requestedPause && buffered.length && pending.size < OUTPUT_WINDOW) {
    const data = buffered.slice(0, OUTPUT_CHUNK);
    buffered = buffered.slice(data.length);
    const sequence = nextSequence++;
    pending.set(sequence, data.length); outstanding += data.length;
    send({ type: 'data', id: owner.id, sequence, data });
  }
  armConsumption(); flow(); finishWhenDrained();
}
function requestStop() {
  if (completed) return;
  closing = true; buffered = ''; pending.clear(); outstanding = 0;
  clearTimeout(consumptionTimer); consumptionTimer = undefined;
  if (owner) owner.killRequested = true;
  if (terminal && !nativeExit && owner.killCalls === 0) {
    owner.killCalls++;
    try { publish(); terminal.kill(); } catch { failure ??= 'native-failure'; }
  }
  if (!terminal) {
    clearTimeout(firstFrameTimer);
    completed = true;
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }
  if (!stopTimer) stopTimer = setTimeout(() => {
    failure ??= 'shutdown-unconfirmed';
    owner.status = 'failed'; owner.teardownConfirmed = false;
    try { publish(); if (process.connected) send({ type: 'fault', id: owner.id, code: 'shutdown-unconfirmed' }); } catch { /* Parent retains its prepublished ownership marker. */ }
    process.exitCode = 1;
    // Do not claim a native exit or force process.exit. Parent must observe/join
    // the owned wrapper or mark it unconfirmed and retain all fixture roots.
    if (process.connected) process.disconnect();
  }, 5_000);
  finishWhenDrained();
}
function fail(code) {
  if (completed || failure) return;
  failure = code;
  if (owner) {
    owner.status = 'failed'; owner.teardownConfirmed = false;
    try { publish(); if (process.connected) send({ type: 'fault', id: owner.id, code }); } catch { /* Existing parent marker remains pending. */ }
  }
  requestStop();
}
function finishWhenDrained() {
  if (completed || !nativeExit || !closing && (buffered.length || pending.size)) return;
  completed = true;
  clearTimeout(consumptionTimer); clearTimeout(stopTimer); clearTimeout(firstFrameTimer);
  for (const subscription of subscriptions) {
    try { subscription.dispose(); } catch { failure ??= 'native-failure'; }
  }
  // The native process has exited. Do not call kill or look up its old PID:
  // node-pty's ConPTY kill path can otherwise target a reused shell PID.
  // This dedicated driver releases its own remaining I/O workers/handles only
  // after publishing the receipt and successfully sending the final frame.
  owner.status = failure ? 'failed' : 'exited'; owner.exitCode = nativeExit.exitCode;
  owner.signal = nativeExit.signal ?? null; owner.teardownConfirmed = failure === null;
  try { publish(); } catch { failure ??= 'native-failure'; }
  try {
    if (failure) send({ type: 'fault', id: owner.id, code: failure }, () => process.exit(1));
    else send({ type: 'exit', id: owner.id, driverPid: process.pid, ptyPid: owner.ptyPid,
      exitCode: owner.exitCode, signal: owner.signal, killRequested: owner.killRequested,
      killCalls: owner.killCalls, teardownConfirmed: true }, () => process.exit(0));
  } catch { process.exit(1); }
}
function verifyOwner() {
  const stat = lstatSync(ownFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Private PTY ledger required.');
  const value = JSON.parse(readFileSync(ownFile, 'utf8'));
  const keys = ['version', 'id', 'parentPid', 'driver', 'driverSha256', 'driverPid', 'ptyPid', 'root', 'home', 'cwd', 'shell',
    'status', 'exitCode', 'signal', 'killRequested', 'killCalls', 'teardownConfirmed'];
  if (!exact(value, keys) || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)
    || value.parentPid !== process.ppid || value.driverPid !== process.pid || value.ptyPid !== null || value.status !== 'pending'
    || value.exitCode !== null || value.signal !== null || value.killRequested !== false || value.killCalls !== 0 || value.teardownConfirmed !== false) throw new Error('Invalid private PTY owner.');
  for (const key of ['root', 'home', 'cwd', 'shell', 'driver']) {
    if (typeof value[key] !== 'string' || value[key].length > 32_768 || !path.isAbsolute(value[key]) || realpathSync(value[key]) !== value[key]) throw new Error('Noncanonical PTY path.');
  }
  const testRoot = realpathSync(process.env.FATE_V2_TEST_ROOT ?? '');
  const ownDriver = realpathSync(fileURLToPath(import.meta.url));
  const systemShell = realpathSync(process.platform === 'win32'
    ? path.join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh');
  if (value.root === testRoot || !inside(testRoot, value.root) || !inside(value.root, value.home) || value.home === value.root
    || !inside(testRoot, value.cwd) || value.cwd === testRoot || inside(testRoot, systemShell) || value.shell !== systemShell
    || !statSync(value.cwd).isDirectory() || !statSync(value.home).isDirectory() || !statSync(systemShell).isFile()
    || realpathSync(process.cwd()) !== value.root || realpathSync(process.env.HOME ?? '') !== value.home
    || path.dirname(realpathSync(ownFile)) !== value.root || path.basename(ownFile) !== `owned-${value.id}.json`
    || ownDriver !== value.driver || createHash('sha256').update(readFileSync(ownDriver)).digest('hex') !== value.driverSha256) throw new Error('PTY fixture provenance mismatch.');
  // The owning launcher guarantees Windows private ACLs; verify restrictive
  // POSIX permissions too. This is not a same-account hostile-code sandbox.
  if (process.platform !== 'win32' && [testRoot, value.root, value.home].some(dir => (statSync(dir).mode & 0o077) !== 0)) throw new Error('Nonprivate PTY directories.');
  return value;
}
function shellEnvironment() {
  const home = owner.home;
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_RUNTIME_DIR: path.join(home, 'runtime'),
    TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'),
    PATH: [...new Set([path.dirname(owner.shell), path.dirname(realpathSync(process.execPath))])].join(path.delimiter),
    LANG: 'C', LC_ALL: 'C', TERM: 'xterm-256color', TZ: 'UTC', NO_COLOR: '1' };
  if (process.platform === 'win32') {
    env.SYSTEMROOT = path.dirname(path.dirname(owner.shell)); env.WINDIR = env.SYSTEMROOT; env.COMSPEC = owner.shell;
  }
  return env;
}
function start(frame) {
  if (!exact(frame, ['type', 'cols', 'rows']) || !dimensions(frame)) throw new Error('Invalid native PTY start frame.');
  owner = verifyOwner(); started = true; clearTimeout(firstFrameTimer);
  const require = createRequire(import.meta.url);
  const pty = require('node-pty'); // Fixed installed dependency; no application or provider module imports.
  terminal = pty.spawn(owner.shell, process.platform === 'win32' ? ['/d', '/q'] : ['-f'], {
    cwd: owner.cwd, env: shellEnvironment(), cols: frame.cols, rows: frame.rows, name: 'xterm-256color', encoding: 'utf8',
  });
  subscriptions.push(terminal.onData(data => {
    if (completed || closing) return;
    try {
      if (typeof data !== 'string' || data.length > OUTPUT_BUFFER || buffered.length + data.length > OUTPUT_BUFFER) { fail('output-limit'); return; }
      buffered += data; flush();
    } catch { fail('native-failure'); }
  }));
  subscriptions.push(terminal.onExit(event => {
    if (completed) return;
    if (!integer(event.exitCode, Number.MIN_SAFE_INTEGER) || event.signal !== undefined && !integer(event.signal, 0)) { fail('native-failure'); return; }
    nativeExit = event;
    try { finishWhenDrained(); } catch { fail('native-failure'); }
  }));
  if (!integer(terminal.pid, 1)) throw new Error('Native PTY did not report an owned PID.');
  owner.ptyPid = terminal.pid; owner.status = 'running'; publish();
  send({ type: 'started', id: owner.id, driverPid: process.pid, ptyPid: terminal.pid });
}
const firstFrameTimer = setTimeout(() => fail('invalid-start'), 5_000);
process.on('message', input => {
  if (completed) return;
  try {
    if (typeof input !== 'string' || Buffer.byteLength(input) > FRAME_BYTES) throw new Error('Invalid native PTY JSON frame.');
    const frame = JSON.parse(input);
    if (!started) { if (frame?.type !== 'start') throw new Error('Native PTY must start first.'); start(frame); return; }
    if (closing) { if (['kill', 'consume'].includes(frame?.type)) return; throw new Error('Native PTY is closing.'); }
    switch (frame?.type) {
      case 'write':
        if (!exact(frame, ['type', 'data']) || typeof frame.data !== 'string' || frame.data.length > 16_384) throw new Error('Invalid terminal input.');
        terminal.write(frame.data); break;
      case 'resize':
        if (!exact(frame, ['type', 'cols', 'rows']) || !dimensions(frame)) throw new Error('Invalid resize.');
        terminal.resize(frame.cols, frame.rows); break;
      case 'consume': {
        const sequence = pending.keys().next().value;
        if (!exact(frame, ['type', 'sequence', 'characters']) || !integer(frame.sequence, 1) || !integer(frame.characters, 1, OUTPUT_CHUNK)
          || sequence !== frame.sequence || pending.get(sequence) !== frame.characters) throw new Error('Invalid consumption ACK.');
        pending.delete(sequence); outstanding -= frame.characters;
        clearTimeout(consumptionTimer); consumptionTimer = undefined; flush(); break;
      }
      case 'pause': case 'resume': case 'clear': case 'kill':
        if (!exact(frame, ['type'])) throw new Error('Unexpected control fields.');
        if (frame.type === 'kill') requestStop();
        else if (frame.type === 'clear') terminal.clear();
        else { requestedPause = frame.type === 'pause'; flush(); }
        break;
      default: throw new Error('Unknown native PTY control.');
    }
  } catch { fail(started ? 'invalid-frame' : 'invalid-start'); }
});
process.on('disconnect', () => { if (!completed) fail('owner-lost'); });
process.on('SIGTERM', () => { if (!completed) fail('owner-lost'); });
process.on('SIGINT', () => { if (!completed) fail('owner-lost'); });
