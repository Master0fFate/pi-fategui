import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIsolatedEnvironment } from './run-v2-tests.mjs';
import { runOwnedVerificationProcess } from './owned-verification-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scopes = ['core', 'browser', 'desktop', 'full'];

export function parseVerificationArgs(args) {
  const options = { scope: 'full', plan: false, artifacts: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Repeated verification option: ${flag}`);
    seen.add(flag);
    if (flag === '--plan') options.plan = true;
    else if (flag === '--artifacts') options.artifacts = true;
    else if (flag === '--scope' && scopes.includes(args[index + 1])) options.scope = args[++index];
    else throw new Error('Usage: verify-v2.mjs [--scope core|browser|desktop|full] [--artifacts] [--plan]');
  }
  if (options.artifacts && options.scope !== 'full') throw new Error('--artifacts is only meaningful with --scope full.');
  return options;
}

export function verificationPlan(options, platform = process.platform) {
  const level = scopes.indexOf(options.scope);
  if (level < 0) throw new Error('Unknown verification scope.');
  const script = (id, file, args = []) => ({ id, args: [path.join(root, 'scripts', file), ...args] });
  const gates = [
    { id: 'typecheck', args: [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'] },
    script('boundaries', 'check-v2-boundaries.mjs'),
    script('v2', 'run-v2-tests.mjs'),
    script('contract', 'run-v2-tests.mjs', ['tests/v2/ipcContractParity.test.ts']),
    { id: 'unit', args: ['--import', pathToFileURL(path.join(root, 'tests/v2/helpers/nodeGuard.mjs')).href,
      path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--config', path.join(root, 'vitest.verify.config.ts')] },
    ...['main', 'preload', 'renderer', 'server', 'web', 'cli'].map((target) => ({ id: `build-${target}`,
      args: [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(root, `vite.${target}.config.ts`)] })),
    script('server-smoke', 'smoke-server.mjs'),
    script('network', 'run-network-tests.mjs'),
  ];
  const pending = [];
  if (platform === 'win32') pending.push({ id: 'windows-process-tree', reason: 'The Windows Job Object supervisor requires native validation on this exact source candidate. Its per-gate receipts require observed zero active job processes; source inspection or a direct child exit is not native validation.' });
  if (level >= 1) gates.push(script('browser', 'run-web-tests.mjs'));
  else pending.push({ id: 'browser', reason: 'Outside selected core scope.' });
  if (level >= 2) {
    gates.push({ id: 'build-e2e', args: [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', path.join(root, 'vite.e2e.config.ts')] });
    gates.push({ id: 'desktop', args: [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(root, 'playwright.config.ts')] });
    if (platform === 'win32') gates.push(script('windows-launcher', 'check-windows-launcher.mjs'), script('windows-tty', 'check-windows-tty.mjs'));
  } else pending.push({ id: 'desktop', reason: 'Requires the native desktop scope and an installed compatible Electron/display.' });
  if (options.scope === 'full' && options.artifacts) {
    gates.push(script('server-package', 'package-server.mjs'), script('server-package-smoke', 'smoke-server-package.mjs'));
  } else pending.push({ id: 'server-package', reason: 'Artifact creation is opt-in; full scope also requires --artifacts.' });
  pending.push(
    { id: 'legacy-browser-smoke', reason: 'The historical test:browser-smoke gate is separate; broader test:web is listed independently and does not relabel its result.' },
    { id: 'remote', reason: 'Run test:remote separately with its approved preinstalled fixture, prerequisite reviews, and explicit activation; this verifier never provisions or authorizes a host.' },
    { id: 'platform-matrix', reason: 'Each advertised OS/architecture needs its own actual native evidence.' },
    { id: 'human-acceptance', reason: 'The user or maintainer must validate the exact candidate; automated checks do not sign human acceptance.' },
  );
  return { scope: options.scope, gates, pending };
}

export function verificationSummary(plan, results, unchanged, interrupted = null) {
  const failed = results.filter((result) => result.status !== 'passed');
  const complete = results.length === plan.gates.length && plan.gates.every((gate, index) => results[index]?.id === gate.id);
  const automatedPassed = complete && failed.length === 0 && unchanged && interrupted === null;
  const status = interrupted ? 'cancelled' : !unchanged ? 'source-changed' : !complete || failed.length ? 'failed' : plan.scope === 'full' ? 'manual-gates-pending' : 'selected-checks-passed';
  return { status, scope: plan.scope, automatedPassed, releaseReady: false, sourceUnchanged: unchanged,
    results, pending: plan.pending, interrupted, exitCode: interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : !automatedPassed ? 1 : plan.scope === 'full' ? 2 : 0 };
}

async function sourceIdentity() {
  const isolated = await createIsolatedEnvironment();
  let head, listed;
  try {
    const git = (args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      { cwd: root, env: { ...isolated.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' });
    head = git(['rev-parse', 'HEAD']).trim();
    listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0');
  } finally { await isolated.cleanup(); }
  // Include every Git source input, including HTML, build launchers, CSS tooling,
  // notices and newly added modules. Exclude only private or generated containers
  // which are not inputs to any automatically admitted gate here.
  const names = [...new Set(listed.filter((name) => name && !/^(?:plans|node_modules|dist|release|\.test-dist|test-results|playwright-report|coverage)(?:\/|$)/u.test(name)
    && !/^COMPACT-HANDOFF-(?:MANIFEST\.json|README\.md)$/u.test(name)))].sort();
  const digest = createHash('sha256');
  for (const name of names) {
    let stat;
    try { stat = await lstat(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') { digest.update(`${name}\0deleted\0`); continue; } throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Verification source must be a regular file: ${name}`);
    digest.update(name).update('\0').update(createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')).update('\0');
  }
  return { head, files: names.length, sha256: digest.digest('hex') };
}

/** Keep local GUI access without restoring the caller's whole HOME/runtime environment. */
export async function configureLocalDisplay(env, inherited = process.env, platform = process.platform) {
  if (platform !== 'linux') return;
  if (inherited.DISPLAY !== undefined) {
    if (!/^(?:unix)?:[0-9]+(?:\.[0-9]+)?$/u.test(inherited.DISPLAY)) throw new Error('Verification permits only a local X11 DISPLAY.');
    env.DISPLAY = inherited.DISPLAY;
    if (inherited.XAUTHORITY !== undefined) {
      if (!path.isAbsolute(inherited.XAUTHORITY) || inherited.XAUTHORITY.includes('\0')) throw new Error('XAUTHORITY must name an absolute local file.');
      const stat = await lstat(inherited.XAUTHORITY);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('XAUTHORITY must be an owned regular local file.');
      env.XAUTHORITY = inherited.XAUTHORITY;
    }
  }
  if (inherited.WAYLAND_DISPLAY !== undefined) {
    const name = inherited.WAYLAND_DISPLAY;
    if (!name || name.includes('\0') || !path.isAbsolute(name) && (path.basename(name) !== name || !path.isAbsolute(inherited.XDG_RUNTIME_DIR ?? ''))) throw new Error('WAYLAND_DISPLAY must resolve to an absolute local socket.');
    const socket = path.isAbsolute(name) ? name : path.join(inherited.XDG_RUNTIME_DIR, name);
    const stat = await lstat(socket);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('WAYLAND_DISPLAY must be an owned local socket.');
    // Relative Wayland names would resolve inside the new empty private runtime
    // directory. Pass the validated absolute socket, leaving all other state private.
    env.WAYLAND_DISPLAY = socket;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseVerificationArgs(args);
  const plan = verificationPlan(options);
  if (options.plan) { process.stdout.write(JSON.stringify({ ...plan, executed: false, releaseReady: false }, null, 2) + '\n'); return 0; }
  const before = await sourceIdentity();
  const results = [];
  let interrupted = null;
  const cancellation = new AbortController();
  const cancel = (signal) => { interrupted ??= signal; cancellation.abort(signal); };
  const onInterrupt = () => cancel('SIGINT'), onTerminate = () => cancel('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  try {
  for (const gate of plan.gates) {
    if (interrupted) break;
    const isolated = await createIsolatedEnvironment();
    if (interrupted) { await isolated.cleanup(); break; }
    // Browser paths do not import the caller's credentials or unrelated state.
    for (const name of ['FATE_WEB_CHROMIUM_EXECUTABLE', 'PLAYWRIGHT_BROWSERS_PATH']) if (process.env[name] !== undefined) isolated.env[name] = process.env[name];
    let result;
    const receipt = { id: gate.id, command: [process.execPath, ...gate.args], startedAt: new Date().toISOString() };
    try {
      if (gate.id === 'desktop') await configureLocalDisplay(isolated.env);
      if (interrupted) break;
      result = await runOwnedVerificationProcess({ args: gate.args, cwd: root, env: isolated.env,
        onStarted: (child) => { receipt.pid = child.pid; process.stdout.write(`FATE_VERIFY_START ${JSON.stringify(receipt)}\n`); } }, cancellation.signal);
      const status = interrupted ? 'cancelled' : result.code === 0 && result.signal === null && result.cancelled === null && !result.timedOut && result.ownership === 'settled' && !result.failure ? 'passed' : 'failed';
      results.push({ ...receipt, ...result, status, finishedAt: new Date().toISOString() });
    } catch (error) {
      results.push({ ...receipt, code: null, signal: null, status: interrupted ? 'cancelled' : 'failed', failure: error.message, finishedAt: new Date().toISOString() });
    } finally {
      await isolated.cleanup({ retain: interrupted !== null || result?.cancelled != null || Boolean(result?.timedOut) || result?.code !== 0 || result?.signal !== null || result?.ownership !== 'settled' || Boolean(result?.failure) });
    }
    process.stdout.write(`FATE_VERIFY_END ${JSON.stringify(results.at(-1))}\n`);
    if (interrupted || results.at(-1).status !== 'passed') break;
  }
  const after = await sourceIdentity();
  const summary = { ...verificationSummary(plan, results, before.sha256 === after.sha256 && before.head === after.head, interrupted), before, after };
  process.stdout.write(`FATE_VERIFY_RESULT ${JSON.stringify(summary)}\n`);
  return summary.exitCode;
  } finally { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
