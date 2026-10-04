// Preinstall this file on the disposable host. Never runs sshd, services, sudo,
// deployments or SDK patches. Each control SSH process exits independently of
// the detached host whose actual Linux PID/start identity is recorded.
import assert from 'node:assert/strict';
import { promises as fs, openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { until, Evidence } from './fixture-lib.mjs';
import { verifyReviewedBinding } from './fixture-binding.mjs';
const [file, action, caseName, expectedBindingDigest] = process.argv.slice(2);
assert.equal(process.platform, 'linux'); assert.notEqual(process.getuid(), 0, 'Non-root fixture only');
const c = JSON.parse(await fs.readFile(file, 'utf8'));
const bindingBytes = await fs.readFile(c.reviewedBindingFile);
assert.equal(createHash('sha256').update(bindingBytes).digest('hex'), expectedBindingDigest, 'Controller requires the independently reviewed expected binding digest');
await verifyReviewedBinding(JSON.parse(bindingBytes.toString('utf8')), expectedBindingDigest, c.reviewedBindingFile);
assert(path.isAbsolute(c.root) && c.root !== '/' && c.root !== process.env.HOME);
assert.equal(await fs.readFile(path.join(c.root, '.fate-t50-disposable'), 'utf8'), 'T50 disposable preinstalled fixture\n');
assert.equal((await fs.lstat(c.root)).isSymbolicLink(), false);
assert.equal(await fs.realpath(c.root), c.root, 'Fixture root must be canonical');
assert(Number.isSafeInteger(c.hostPort) && c.hostPort > 0 && c.hostPort < 65535);
assert(Number.isSafeInteger(c.localPort) && c.localPort > 0 && c.localPort <= 65535);
assert.equal((await fs.stat(c.root)).uid, process.getuid());
assert.equal((await fs.stat(c.root)).mode & 0o077, 0, 'Fixture root must be private');
for (const name of ['node', 'hostEntry', 'productionEntry', 'productionRoot']) assert(path.isAbsolute(c[name]));
const name = caseName ?? 'tunnel'; assert(['tunnel', 'crash', 'stall'].includes(name));
const dir = path.join(c.root, name);
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const fixtureEnvironment = home => ({ PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, FATE_V2_TEST_ROOT: c.root,
  PI_OFFLINE: '1', NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' });
async function runProbe(args, home, deadlineMs) {
  const root = path.join(c.root, 'control-probes', randomUUID()); await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const evidence = new Evidence(root);
  return evidence.run(c.node, args, { cwd: c.root, env: fixtureEnvironment(home), deadlineMs, graceMs: 1000, forceMs: 2000 });
}
async function identity(pid) {
  const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return { pid, startIdentity: text.slice(text.lastIndexOf(')') + 2).split(' ')[19] };
}
async function owner() {
  const recorded = JSON.parse(await fs.readFile(path.join(dir, 'process.json'), 'utf8'));
  assert.deepEqual(await identity(recorded.pid), recorded, 'PID reuse: refusing to signal unrelated process'); return recorded;
}
async function directive(command) {
  await owner(); const id = randomUUID();
  await fs.writeFile(path.join(dir, 'directive.tmp'), JSON.stringify({ id, action: command }), { mode: 0o600 });
  await fs.rename(path.join(dir, 'directive.tmp'), path.join(dir, 'directive.json'));
  const reply = await until(() => fs.readFile(path.join(dir, 'reply.json'), 'utf8').then(JSON.parse, () => null), v => v?.id === id, command);
  assert.equal(reply.ok, true, reply.error); return reply.result;
}
if (action === 'supervise') {
  const attempt = randomUUID(); const out = openSync(path.join(dir, `${attempt}.stdout.log`), 'ax', 0o600); const err = openSync(path.join(dir, `${attempt}.stderr.log`), 'ax', 0o600);
  const child = spawn(c.node, [c.hostEntry, file, name], { cwd: c.root, shell: false, stdio: ['ignore', out, err],
    env: fixtureEnvironment(path.join(dir, 'home')) });
  closeSync(out); closeSync(err);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  void exit.catch(() => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const state = await identity(child.pid);
  await fs.writeFile(path.join(dir, 'process.json'), JSON.stringify(state), { mode: 0o600 });
  const result = { ...state, ...await exit, supervisor: await identity(process.pid), attempt };
  await fs.writeFile(path.join(dir, `host-exit-${attempt}.json`), JSON.stringify(result), { mode: 0o600 });
  await fs.appendFile(path.join(dir, 'host-exits.jsonl'), JSON.stringify(result) + '\n', { mode: 0o600 });
} else if (action === 'preflight') {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || major === 22 && minor >= 19, 'Node >=22.19 required');
  assert.equal(c.allowCrashLockQuarantine, true, 'Complete external fixture needs explicit narrow crash-lock quarantine authorization');
  for (const field of ['node', 'hostEntry', 'productionEntry']) assert((await fs.stat(c[field])).isFile());
  for (const relative of ['SHA256SUMS', 'LINKS.json', 'dist/server/main.js']) assert((await fs.stat(path.join(c.productionRoot, relative))).isFile());
  output({ platform: process.platform, arch: process.arch, uid: process.getuid(), node: process.version, hostEntry: c.hostEntry,
    productionEntry: c.productionEntry, productionRoot: c.productionRoot, root: c.root, hostPort: c.hostPort, localPort: c.localPort,
    controller: await identity(process.pid), preinstalled: true,
    configDigest: createHash('sha256').update(await fs.readFile(file)).digest('hex'),
    controllerDigest: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),
    testHostDigest: createHash('sha256').update(await fs.readFile(c.hostEntry)).digest('hex') });
} else if (action === 'prepare') {
  // Exclusive per-case creation: never remove/reinitialize evidence from a prior run.
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.mkdir(path.join(dir, 'home'), { mode: 0o700 }); await fs.mkdir(path.join(dir, 'workspace'), { mode: 0o700 });
  const ws = path.join(dir, 'workspace');
  const git = (...args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', env: fixtureEnvironment(path.join(dir, 'home')) });
  git('init', '--quiet'); git('config', '--local', 'user.name', 'T50 Fixture'); git('config', '--local', 'user.email', 't50@example.invalid');
  git('config', '--local', 'commit.gpgSign', 'false'); git('config', '--local', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(ws, 'sentinel.txt'), 'remote preimage\n'); git('add', 'sentinel.txt'); git('commit', '--quiet', '-m', 'fixture preimage');
  output({ sentinelBase64: (await fs.readFile(path.join(ws, 'sentinel.txt'))).toString('base64'), head: git('rev-parse', 'HEAD').trim(), diff: git('diff', '--no-ext-diff') });
} else if (action === 'start') {
  try { await owner(); throw new Error('Host already running'); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e; }
  await fs.rm(path.join(dir, 'ready.json'), { force: true });
  const supervisorLog = openSync(path.join(dir, `${randomUUID()}.supervisor.log`), 'ax', 0o600);
  const supervisor = spawn(c.node, [fileURLToPath(import.meta.url), file, 'supervise', name, expectedBindingDigest], {
    cwd: c.root, detached: true, shell: false, stdio: ['ignore', supervisorLog, supervisorLog], env: fixtureEnvironment(path.join(dir, 'home')),
  });
  closeSync(supervisorLog);
  await new Promise((resolve, reject) => { supervisor.once('spawn', resolve); supervisor.once('error', reject); });
  const supervisorIdentity = await identity(supervisor.pid); supervisor.unref();
  const ready = await until(() => fs.readFile(path.join(dir, 'ready.json'), 'utf8').then(JSON.parse, () => null), v => v?.pid > 0, 'host ready');
  assert.deepEqual(await owner(), { pid: ready.pid, startIdentity: ready.startIdentity });
  output({ ...ready, supervisor: supervisorIdentity });
} else if (action === 'kill') {
  const state = await owner(); process.kill(state.pid, 'SIGKILL');
  await until(() => fs.readFile(`/proc/${state.pid}/stat`, 'utf8').catch(() => ''), text => !text || text.slice(text.lastIndexOf(')') + 2).startsWith('Z '), 'host death');
  const exited = await until(() => fs.readFile(path.join(dir, 'host-exits.jsonl'), 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse).find(v => v.pid === state.pid && v.startIdentity === state.startIdentity), () => null), v => v?.signal === 'SIGKILL', 'supervisor actual host exit');
  await fs.appendFile(path.join(dir, 'exit-observations.jsonl'), JSON.stringify({ ...state, observedSignal: 'SIGKILL', observer: process.pid, actualExit: exited }) + '\n', { mode: 0o600 });
  await fs.rm(path.join(dir, 'process.json'));
  output(exited);
} else if (action === 'recover-crash-locks') {
  // Explicit fixture-owner recovery, NEVER PID/heartbeat auto-recovery and
  // NEVER used for stalled/live ownership. Preserve the exact old lock dirs.
  assert.equal(name, 'crash'); assert.equal(c.allowCrashLockQuarantine, true, 'Explicit test-fixture crash lock recovery authorization required');
  const barrier = JSON.parse(await fs.readFile(path.join(dir, 'before-response.json'), 'utf8'));
  assert.equal(barrier.admittedEffect, true); assert.equal(barrier.responseReleased, false);
  const exits = (await fs.readFile(path.join(dir, 'host-exits.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(exits.some(exit => exit.pid === barrier.pid && exit.startIdentity === barrier.startIdentity && exit.signal === 'SIGKILL'), 'Actual child death/identity proof required');
  try { process.kill(barrier.pid, 0); throw new Error('PID still exists or was reused: refuse lock recovery'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const captured = JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8')).lockRecords;
  assert(captured.some(lock => path.basename(lock.directory).startsWith('profile-')));
  assert(captured.some(lock => path.basename(lock.directory).startsWith('checkout-')));
  for (const lock of captured) {
    assert.equal(lock.record.pid, barrier.pid); assert(lock.directory.startsWith(path.join(dir, 'home') + path.sep));
    assert.equal(await fs.realpath(lock.directory), lock.directory);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(lock.directory, `owner-${lock.record.token}.json`), 'utf8')), lock.record, 'Owner token/record drift: refuse recovery');
  }
  const quarantine = path.join(dir, `quarantined-crash-locks-${randomUUID()}`); await fs.mkdir(quarantine, { mode: 0o700 });
  for (const lock of captured) await fs.rename(lock.directory, path.join(quarantine, path.basename(lock.directory)));
  const proof = { authorization: 'explicit disposable fixture crash recovery only', barrier, captured, quarantine };
  await fs.writeFile(path.join(quarantine, 'recovery.json'), JSON.stringify(proof), { mode: 0o600 }); output(proof);
} else if (action === 'barrier') output(JSON.parse(await fs.readFile(path.join(dir, 'before-response.json'), 'utf8').catch(() => 'null')));
else if (action === 'contend-profile' || action === 'contend-checkout') {
  await owner();
  output(await runProbe([c.hostEntry, file, name, action === 'contend-profile' ? 'profile' : 'checkout'], path.join(dir, 'home'), 10000));
} else if (action === 'production') {
  output(await runProbe([c.productionEntry, file], path.join(c.root, 'production-home'), 15000));
} else if (action === 'logs') {
  const logs = {};
  const collect = async (directory, prefix) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); const key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(file, key);
      else if (entry.isFile() && /\.(?:log|jsonl)$/u.test(entry.name)) logs[key] = await fs.readFile(file, 'utf8');
    }
  };
  await collect(dir, name);
  await collect(path.join(c.root, 'control-probes'), 'control-probes').catch(error => { if (error.code !== 'ENOENT') throw error; });
  output(logs);
} else output(await directive(action));
