import assert from 'node:assert/strict';
import { mkdtemp, access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { it as test } from 'vitest';
import { runOwnedVerificationProcess } from './owned-verification-process.mjs';

// The OS PowerShell/C# bootstrap has its own 90-second cold-start budget.
// Bound these legacy Vitest cases without changing any settlement assertion.
const ownedTestTimeout = process.platform === 'win32' ? 120_000 : 5_000;

test('owned verification observes an ordinary child and refuses pre-cancelled launch', async () => {
  const normal = await runOwnedVerificationProcess({ args: ['-e', 'process.exitCode=0'], env: process.env, stdio: 'ignore' });
  assert.equal(normal.code, 0); assert.equal(normal.ownership, 'settled');
  const controller = new AbortController(); controller.abort('SIGINT');
  const cancelled = await runOwnedVerificationProcess({ args: ['-e', 'throw new Error("must not launch")'], env: process.env,
    onStarted: () => assert.fail('Pre-cancelled child started') }, controller.signal);
  assert.equal(cancelled.started, false); assert.equal(cancelled.cancelled, 'SIGINT');
}, ownedTestTimeout);

test('cancellation stops the owned process tree before a descendant delayed effect', async () => {
  assert(process.env.FATE_V2_TEST_ROOT, 'Use a private isolated test root');
  const directory = await mkdtemp(path.join(process.env.FATE_V2_TEST_ROOT, 'owned-verification-'));
  const marker = path.join(directory, 'descendant-effect');
  const controller = new AbortController();
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1000);setInterval(()=>{},1000)`;
  const wrapper = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.once('spawn',()=>process.stdout.write('ready'));process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)`;
  const result = await runOwnedVerificationProcess({ args: ['-e', wrapper], env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    onStarted: (child) => child.stdout.once('data', () => controller.abort('SIGINT')) }, controller.signal);
  assert.equal(result.cancelled, 'SIGINT'); assert.notEqual(result.code, 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(access(marker), { code: 'ENOENT' });
  // Even when OS reaping cannot be confirmed, never claim the private root can
  // be reclaimed. The verifier retains it based on this explicit result.
  assert(['settled', 'unconfirmed'].includes(result.ownership));
  if (result.ownership === 'settled') await rm(directory, { recursive: true });
  else await writeFile(path.join(process.env.FATE_V2_TEST_ROOT, '.fate-retained-owned-work.json'), JSON.stringify({ reason: 'verification tree close unconfirmed', pid: result.pid }));
}, ownedTestTimeout);
