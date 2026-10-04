import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { parseVerificationArgs, verificationPlan, verificationSummary } from './verify-v2.mjs';

test('verification scopes are explicit and artifact work is never implicitly enabled', () => {
  assert.deepEqual(parseVerificationArgs([]), { scope: 'full', plan: false, artifacts: false });
  for (const args of [['--scope', 'wat'], ['--plan', '--plan'], ['--artifacts', '--scope', 'core'], ['--scope', 'core', '--scope', 'full'], ['--run', 'shell']]) assert.throws(() => parseVerificationArgs(args));
  const source = verificationPlan(parseVerificationArgs(['--scope', 'core']), 'linux');
  assert(!source.gates.some((gate) => /package|desktop|browser|remote/u.test(gate.id)));
  assert(source.pending.some((gate) => gate.id === 'remote'));
  for (const id of ['v2', 'unit']) {
    const args = source.gates.find((gate) => gate.id === id).args;
    assert.equal(args[args.indexOf('--bail') + 1], '1');
    assert(!args.some((value) => /--(?:testNamePattern|exclude|shard)/u.test(value)));
  }
  const full = verificationPlan(parseVerificationArgs([]), 'win32');
  assert(full.gates.some((gate) => gate.id === 'windows-launcher'));
  assert(!full.gates.some((gate) => gate.id === 'server-package'));
  assert(verificationPlan(parseVerificationArgs(['--artifacts'])).gates.some((gate) => gate.id === 'server-package'));
});

test('a focused pass never becomes release readiness or substitutes for missing human/native gates', () => {
  const plan = verificationPlan(parseVerificationArgs(['--scope', 'core']));
  const passed = plan.gates.map((gate) => ({ id: gate.id, status: 'passed', code: 0, signal: null }));
  assert.equal(verificationSummary(plan, passed, true).status, 'selected-checks-passed');
  assert.equal(verificationSummary(plan, passed, true).releaseReady, false);
  assert.equal(verificationSummary(plan, passed, true).exitCode, 0);
  assert.equal(verificationSummary(plan, passed, true, 'SIGINT').exitCode, 130);
  assert.equal(verificationSummary(plan, passed, true, 'SIGTERM').automatedPassed, false);
  assert.equal(verificationSummary(plan, passed, true, 'SIGTERM').status, 'cancelled');
  assert.equal(verificationSummary(plan, passed.slice(1), true).exitCode, 1);
  assert.equal(verificationSummary(plan, [...passed].reverse(), true).automatedPassed, false);
  assert.equal(verificationSummary(plan, passed, false).status, 'source-changed');
  const full = verificationPlan(parseVerificationArgs([]));
  const results = full.gates.map((gate) => ({ id: gate.id, status: 'passed' }));
  assert.equal(verificationSummary(full, results, true).exitCode, 2);
  assert.equal(verificationSummary(full, results, true).status, 'manual-gates-pending');
  results[0].status = 'failed';
  assert.equal(verificationSummary(full, results, true).exitCode, 1);
});

test('native display setup keeps local X11 paths and refuses remote or ambiguous transport', async () => {
  const { configureLocalDisplay } = await import('./verify-v2.mjs');
  const env = { XDG_RUNTIME_DIR: '/private/runtime', HOME: '/private/home' };
  await configureLocalDisplay(env, { DISPLAY: ':7.0' }, 'linux');
  assert.equal(env.DISPLAY, ':7.0'); assert.equal(env.HOME, '/private/home');
  await assert.rejects(configureLocalDisplay({}, { DISPLAY: 'example.test:0' }, 'linux'), /local X11/);
  await assert.rejects(configureLocalDisplay({}, { DISPLAY: ':0', XAUTHORITY: 'relative' }, 'linux'), /absolute/);
  await assert.rejects(configureLocalDisplay({}, { WAYLAND_DISPLAY: '../other', XDG_RUNTIME_DIR: '/tmp' }, 'linux'), /absolute/);
  await assert.rejects(configureLocalDisplay({}, { WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), /absolute/);
  await configureLocalDisplay({}, { DISPLAY: 'ignored' }, 'darwin');
});
