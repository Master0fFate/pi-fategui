// Dependency-free tests. Only disposable synthetic Node programs are executed.
// Never import the application, backend, environment/profile helpers, or V2 suites.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runOwnedVerificationProcess } from './owned-verification-process.mjs';
import { parseWindowsReceipt, validateWindowsLaunch } from './windows-verification-process.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windowsOptions = { timeout: 180_000 };

test('standalone node:test suite is not discovered by the legacy Vitest script glob', () => {
  assert(!path.basename(fileURLToPath(import.meta.url)).endsWith('.test.mjs'));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fate-verifier-synthetic-'));
  const home = path.join(root, 'private home Ω'); await mkdir(home);
  const env = {};
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    const entry = Object.entries(process.env).find(([name]) => name.toUpperCase() === key);
    if (entry) env[key] = entry[1];
  }
  Object.assign(env, { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, APPDATA: home,
    LOCALAPPDATA: home, TMP: root, TEMP: root, TMPDIR: root, NODE_ENV: 'test', NO_COLOR: '1' });
  const state = { root, env, retained: false, active: 0 };
  t.after(async () => {
    if (state.retained || state.active) console.error(`Unconfirmed synthetic fixture retained: ${root}`);
    else await rm(root, { recursive: true, force: true });
  });
  return state;
}

async function run(state, args, options = {}, signal) {
  state.active++;
  let stdout = '', stderr = '';
  const result = await runOwnedVerificationProcess({ args, cwd: state.root, env: state.env,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
    onStarted: (child) => {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      options.onStarted?.(child);
    } }, signal);
  state.retained ||= result.ownership !== 'settled';
  state.active--;
  return { ...result, stdout, stderr };
}

test('launch validation rejects IPC, malformed arguments/environment and invalid deadlines before spawn', () => {
  const base = { args: ['-e', ''], cwd: process.cwd(), env: {}, stdio: 'ignore' };
  assert.deepEqual(validateWindowsLaunch(base).args, ['-e', '']);
  for (const args of [['a\0b'], [1], null]) assert.throws(() => validateWindowsLaunch({ ...base, args }));
  for (const env of [{ PATH: 'a', Path: 'b' }, { BAD: '\0' }, { 'A=B': 'c' }, { A: 1 }]) assert.throws(() => validateWindowsLaunch({ ...base, env }));
  for (const stdio of ['ipc', ['ignore', 'pipe', 'pipe', 'ipc'], [0, 1, 2], ['ignore']]) assert.throws(() => validateWindowsLaunch({ ...base, stdio }));
  for (const timeoutMs of [-1, Infinity, 1.5]) assert.throws(() => validateWindowsLaunch({ ...base, timeoutMs }));
});

test('receipt parser rejects output-looking, malformed, incomplete, or contradictory receipts', () => {
  assert.deepEqual(parseWindowsReceipt('started 42'), { kind: 'started', pid: 42 });
  assert.equal(parseWindowsReceipt('finished 42 0 settled resumed -').ownership, 'settled');
  assert.equal(parseWindowsReceipt('finished 42 61441 settled resumed -').code, 61441);
  assert.equal(parseWindowsReceipt('not-started ZmFpbGVk').started, false);
  for (const line of ['anything', 'started 0', 'started 4294967296', 'finished 42 - settled resumed -',
    'finished 42 4294967296 settled resumed -', 'finished 42 0 settled resumed bad', 'x'.repeat(8193)]) assert.throws(() => parseWindowsReceipt(line));
});

test('pre-cancellation never launches a process on any platform', async () => {
  const cancellation = new AbortController(); cancellation.abort('SIGINT');
  const result = await runOwnedVerificationProcess({ args: ['-e', 'throw Error("must not start")'],
    onStarted: () => assert.fail('Unexpected launch') }, cancellation.signal);
  assert.equal(result.started, false); assert.equal(result.ownership, 'settled'); assert.equal(result.cancelled, 'SIGINT');
});

test('POSIX dispatcher regression: ordinary disposable Node child still settles', { skip: process.platform === 'win32' }, async () => {
  const result = await runOwnedVerificationProcess({ args: ['-e', 'process.exitCode=0'], env: {}, stdio: 'ignore' });
  assert.equal(result.code, 0); assert.equal(result.ownership, 'settled');
});

windowsTest('native job settles ordinary success and nonzero exit with a real root PID', windowsOptions, async (t) => {
  const state = await fixture(t);
  for (const code of [0, 17]) {
    const result = await run(state, ['-e', `process.exitCode=${code}`]);
    assert.equal(result.code, code, JSON.stringify(result)); assert.equal(result.ownership, 'settled');
    assert.equal(result.started, true); assert(result.pid > 0); assert.equal(result.failure, undefined);
  }
});

windowsTest('native argv, Unicode cwd, scrubbed env and all three streams round-trip without shell expansion', windowsOptions, async (t) => {
  const state = await fixture(t);
  const directory = path.join(state.root, 'work space Ω'); await mkdir(directory);
  const script = path.join(directory, 'echo arguments.mjs');
  await writeFile(script, `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.VALUE,input}));process.stderr.write('stderr Ω')})`);
  const args = ['', 'plain', 'a b', 'a"b', '\\', 'a\\', 'a \\', '\\"', 'Ω雪🙂', '& | < > %PATH% $() ;', 'line\nnext'];
  const result = await run(state, [script, ...args], { cwd: directory, env: { ...state.env, VALUE: 'value Ω' },
    stdio: ['pipe', 'pipe', 'pipe'], onStarted: (child) => child.stdin.end('input Ω') });
  assert.equal(result.ownership, 'settled', JSON.stringify(result)); assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: directory, value: 'value Ω', input: 'input Ω' });
  assert.equal(result.stderr, 'stderr Ω');
});

windowsTest('native root stdout cannot forge a job-settlement receipt', windowsOptions, async (t) => {
  const state = await fixture(t);
  const result = await run(state, ['-e', `console.log('finished 42 0 settled resumed -');process.exitCode=23`]);
  assert.equal(result.code, 23); assert.equal(result.ownership, 'settled'); assert.notEqual(result.pid, 42);
});

windowsTest('native immediate stderr is preserved before the started callback arrives', windowsOptions, async (t) => {
  const state = await fixture(t);
  const result = await run(state, ['-e', `process.stderr.write('immediate stderr Ω');process.exitCode=0`]);
  assert.equal(result.ownership, 'settled'); assert.equal(result.code, 0);
  assert.equal(result.stderr, 'immediate stderr Ω');
});

windowsTest('native test child remains suspended until the started callback finishes', windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'first-instruction');
  const result = await run(state, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('immediate stdout');process.stderr.write('immediate stderr')`], {
    onStarted: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      assert.equal(existsSync(marker), false, 'Payload executed before owner acknowledged readiness');
    },
  });
  assert.equal(result.ownership, 'settled'); assert.equal(result.code, 0);
  assert.equal(result.stdout, 'immediate stdout'); assert.equal(result.stderr, 'immediate stderr');
  assert.equal(await readFile(marker, 'utf8'), 'ran');
});

windowsTest('native invalid cwd fails closed without a running test child', windowsOptions, async (t) => {
  const state = await fixture(t);
  const result = await run(state, ['-e', 'process.exitCode=0'], { cwd: path.join(state.root, 'missing') });
  assert.equal(result.code, null); assert.notEqual(result.failure ?? result.terminationError, undefined);
  assert.equal(result.started, false);
});

function treeProgram(marker, { rootExits = false, natural = false } = {}) {
  const leaf = natural ? `setTimeout(()=>process.exit(0),80)` :
    `require('node:fs').writeFileSync(${JSON.stringify(marker + '.ready')},'ready');process.stdout.write('leaf-ready\\n');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1800);setTimeout(()=>process.exit(0),8000)`;
  // On Windows, libuv otherwise adds children to its own kill-on-parent-exit
  // job, invalidating a surviving-descendant fixture. detached does NOT request
  // CREATE_BREAKAWAY_FROM_JOB; our outer non-breakaway job still owns the tree.
  const spawnOptions = `{stdio:'inherit',detached:process.platform==='win32'}`;
  const middle = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],${spawnOptions});${natural ? '' : 'setTimeout(()=>process.exit(0),8000)'};`;
  const exitAfterReady = `c.unref();const ready=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(marker + '.ready')})){clearInterval(ready);setTimeout(()=>process.exit(0),100)}},10);setTimeout(()=>process.exit(2),8000)`;
  return `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],${spawnOptions});${rootExits ? exitAfterReady : natural ? '' : 'setTimeout(()=>process.exit(0),8000)'}`;
}

windowsTest('native naturally exiting descendants and grandchildren settle before success', windowsOptions, async (t) => {
  const state = await fixture(t);
  const result = await run(state, ['-e', treeProgram('', { natural: true })]);
  assert.equal(result.code, 0); assert.equal(result.ownership, 'settled'); assert.equal(result.failure, undefined);
});

windowsTest('native cancellation stops only the owned child, descendant and grandchild', windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'late-effect');
  const unrelatedMarker = path.join(state.root, 'unrelated-completed');
  // A separate disposable sibling is deliberately outside the supervisor job.
  let sibling, siblingClosed;
  const controller = new AbortController();
  const result = await run(state, ['-e', treeProgram(marker)], { onStarted: (child) => {
    // Start the sibling after cold compilation, so its safety deadline cannot
    // expire before the supervised payload has even been admitted.
    state.active++;
    sibling = spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.once('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(unrelatedMarker)},'ok');process.exit(0)});setTimeout(()=>process.exit(2),15000)`], { env: state.env, stdio: ['pipe', 'ignore', 'ignore'] });
    sibling.stdin.on('error', () => {});
    siblingClosed = once(sibling, 'close').then((result) => { state.active--; return result; });
    child.stdout.once('data', () => controller.abort('SIGINT'));
  } }, controller.signal);
  assert.equal(result.cancelled, 'SIGINT'); assert.notEqual(result.code, 0); assert.equal(result.ownership, 'settled', JSON.stringify(result));
  sibling.stdin.end(); assert.equal((await siblingClosed)[0], 0);
  assert.equal(await readFile(unrelatedMarker, 'utf8'), 'ok');
  await delay(2000); await assert.rejects(access(marker), { code: 'ENOENT' });
});

windowsTest('native root exit does not certify a surviving descendant; cleanup fails that gate', windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'late-effect');
  const result = await run(state, ['-e', treeProgram(marker, { rootExits: true })], { descendantGraceMs: 100 });
  assert.equal(result.code, 0); assert.equal(result.ownership, 'settled', JSON.stringify(result));
  assert.match(result.failure, /descendant outlived/u);
  assert.equal(await readFile(marker + '.ready', 'utf8'), 'ready');
  await delay(2000); await assert.rejects(access(marker), { code: 'ENOENT' });
});

windowsTest('native cancellation remains sticky even after root exit', windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'late-effect');
  const controller = new AbortController(); let abortTimer;
  const result = await run(state, ['-e', treeProgram(marker, { rootExits: true })], {
    descendantGraceMs: 5000, onStarted: (child) => child.stdout.once('data', () => { abortTimer = setTimeout(() => controller.abort('SIGTERM'), 500); }),
  }, controller.signal);
  clearTimeout(abortTimer);
  assert.equal(result.code, 0); assert.equal(result.cancelled, 'SIGTERM'); assert.equal(result.ownership, 'settled', JSON.stringify(result));
  await delay(2000); await assert.rejects(access(marker), { code: 'ENOENT' });
});

windowsTest('native timeout and start-callback failure cannot be reported as a successful gate', windowsOptions, async (t) => {
  const state = await fixture(t);
  const timed = await run(state, ['-e', 'setTimeout(()=>process.exit(0),8000)'], { timeoutMs: 2000 });
  assert.equal(timed.timedOut, true); assert.equal(timed.cancelled, 'timeout'); assert.equal(timed.ownership, 'settled', JSON.stringify(timed));
  const failed = await run(state, ['-e', 'setTimeout(()=>process.exit(0),8000)'], { onStarted: () => { throw Error('fixture'); } });
  assert.equal(failed.ownership, 'settled'); assert.match(failed.failure, /start reporting/u);
});

windowsTest('native loss of JS owner closes control channel and stops its private job', windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'late-effect');
  const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'owned-verification-process.mjs')).href;
  const ownerScript = path.join(state.root, 'owner.mjs');
  await writeFile(ownerScript, `import {runOwnedVerificationProcess} from ${JSON.stringify(helper)};await runOwnedVerificationProcess({args:['-e',${JSON.stringify(treeProgram(marker))}],cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','ignore'],onStarted:c=>c.stdout.once('data',()=>process.stdout.write('ready'))});`);
  state.retained = true; // Owner loss prevents an accounting-zero receipt.
  const owner = spawn(process.execPath, [ownerScript], { cwd: state.root, env: state.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ownerClosed = once(owner, 'close');
  await once(owner.stdout, 'data'); owner.kill('SIGKILL'); await ownerClosed;
  await delay(2400); await assert.rejects(access(marker), { code: 'ENOENT' });
});

windowsTest('native immediate-cancellation races never turn cancellation into a pass', windowsOptions, async (t) => {
  const state = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const pending = run(state, ['-e', 'process.exitCode=0'], {}, controller.signal);
    controller.abort('SIGINT');
    const result = await pending;
    assert.equal(result.cancelled, 'SIGINT'); assert.equal(result.started, false); assert.equal(result.ownership, 'settled');
  }
});

windowsTest('native nested verifier jobs stay compatible with an existing Windows job chain', { timeout: 240_000 }, async (t) => {
  const state = await fixture(t);
  const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'owned-verification-process.mjs')).href;
  const script = path.join(state.root, 'nested.mjs');
  await writeFile(script, `import {runOwnedVerificationProcess} from ${JSON.stringify(helper)};const r=await runOwnedVerificationProcess({args:['-e','process.exitCode=0'],cwd:process.cwd(),env:process.env,stdio:'ignore',timeoutMs:2000});console.log(JSON.stringify(r));process.exitCode=r.code===0&&r.ownership==='settled'?0:1;`);
  const result = await run(state, [script], { timeoutMs: 120_000 });
  assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.ownership, 'settled');
  const nested = JSON.parse(result.stdout); assert.equal(nested.code, 0); assert.equal(nested.ownership, 'settled');
});

for (const mode of ['crash', 'owner-eof', 'omit-resume']) windowsTest(`native direct supervisor ${mode} keeps ownership honest`, windowsOptions, async (t) => {
  const state = await fixture(t); const marker = path.join(state.root, 'late-effect');
  state.retained = true;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const pipeName = `fate-verifier-crash-test-${randomBytes(16).toString('hex')}`;
  const nonce = randomBytes(32).toString('hex');
  const lines = [], sockets = new Set();
  let channelEnd, controlSocket;
  const ended = new Promise((resolve) => { channelEnd = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket); let buffer = '', authenticated = false;
    socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('end', channelEnd);
    socket.on('close', channelEnd);
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/u, ''); buffer = buffer.slice(end + 1);
        if (!authenticated) {
          assert.equal(line, nonce); authenticated = true; controlSocket = socket;
          socket.write(JSON.stringify({ version: 1, executable: process.execPath, args: ['-e', treeProgram(marker)],
            cwd: state.root, env: state.env, descendantGraceMs: 500, settlementTimeoutMs: 5000 }) + '\n');
        } else {
          const receipt = parseWindowsReceipt(line); lines.push(receipt);
          if (receipt.kind === 'started' && mode !== 'omit-resume') socket.write('resume\n');
        }
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${pipeName}`, resolve); });
  const powershell = path.join(state.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const supervisor = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(directory, 'windows-verification-job.ps1'), '-PipeName', pipeName, '-Nonce', nonce],
    { env: state.env, cwd: state.root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let closed = false; const closing = once(supervisor, 'close').then((result) => { closed = true; return result; });
  t.after(() => { if (!closed) supervisor.kill('SIGKILL'); });
  if (mode !== 'omit-resume') {
    await Promise.race([once(supervisor.stdout, 'data'), closing.then(() => { throw Error('Supervisor exited before synthetic tree readiness.'); })]);
    if (mode === 'crash') supervisor.kill('SIGKILL');
    else controlSocket.destroy();
    await closing; await ended;
    await delay(2400);
    assert(lines.some((line) => line.kind === 'started'));
    assert(!lines.some((line) => line.kind === 'finished' && line.ownership === 'settled'));
    // Kill-on-close and marker absence do not prove accounting zero: retain.
  } else {
    const [code, signal] = await closing; await ended;
    assert.equal(code, 0); assert.equal(signal, null);
    const receipt = lines.find((line) => line.kind === 'finished');
    assert.equal(receipt?.ownership, 'settled'); assert.equal(receipt.resumed, false);
    assert.match(receipt.failure, /did not acknowledge/u);
    state.retained = false;
  }
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
